/** agent_swarm deepseek harness 插件（Cordis）。
 *
 * 职责：
 *   - WS 连服务端 /ws/plugin（agent_type=deepseek 由安装脚本 workspace_add 时登记）
 *   - 收 message/send → per-caller 会话（sessions.json 复用）followup 投递 → 接单即 ack
 *   - session/event 单监听：按 session 路由到任务轮 → 流式上报 text/reasoning/tool、
 *     权限 input-required、turn/end 收尾（artifact + completed / failed）
 *   - approval/request 桥：远程应答（web/飞书/微信先答先算）→ 本插件作为 dsh 的
 *     approval/request waterfall 应答器返回 outcome；本地 UI 先答时 approval/decided
 *     事件到达，远程等待自动撤下
 *
 * 零运行时裸依赖（对齐 opencode V2 插件哲学）：
 *   - createUserMessage ≈ 冻结对象，手构 { role:"user", content:[{type:"text",...}], source:{kind:"user"} }
 *   - SessionId/ApprovalRequestId 等品牌类型运行时就是 string
 *   - 不 import 任何 @deepseek-ai/* 运行时模块（bundle 形态下加载器解析不到 workspace 包）
 *
 * 会话模型：dsh 无「前台会话」概念（web UI 多会话并行、进程常驻即在线），
 * 任务执行位置 = per-caller 会话（同来源任务复用同一会话保证连续性），
 * 用户在 dsh Web UI 随时点开该会话看全程。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { loadConfig } from "./config.ts"
import { readWorkspaceId, readSessionMap, writeSessionEntry } from "./workspace.ts"
import { SwarmHeartbeat } from "./heartbeat.ts"
import {
  startNexusA2AClient,
  type NexusA2AClient,
  type A2aTaskRef,
  statusUpdate,
  agentMessage,
  artifactUpdate,
  inputRequired,
  toolStatus,
  streamStatus,
} from "./ws.ts"
import { swarmCommands } from "./commands.ts"

const LOG_DIR = join(homedir(), ".config", "dsh", "agent-swarm")
const LOG_FILE = join(LOG_DIR, "plugin.log")
const LOG_MAX_BYTES = 1_000_000

function log(msg: string) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      const text = readFileSync(LOG_FILE, "utf-8")
      truncateSync(LOG_FILE, 0)
      appendFileSync(LOG_FILE, text.slice(text.length - LOG_MAX_BYTES / 2))
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // 日志失败不影响主流程
  }
}

export const name = "agent-swarm"

/** 一个进行中的 A2A 任务轮（键 = taskId） */
interface A2aRun {
  sessionId: string
  /** followup 注入时刻之前会话的最大 seq：只认此后的 user/tool/turn 事件 */
  seqBeforeInject: number
  /** followup 已注入（user/message 帧只报注入后的） */
  injected: boolean
  /** 本任务轮认领的 turn 序号（首个 turn/end / turn/start 到达时锁定） */
  claimedTurn: number | null
  lastTextLen: number
  lastReasoningLen: number
  /** 本轮累计最终 assistant 文本（assistant/message 到达时覆盖） */
  finalText: string
  /** 权限等待（input-required 已上报；requestId = dsh ApprovalRequestId） */
  permission: { requestId: string; resolve: (outcome: string) => void } | null
  /** 提问等待（question input-required；requestId = 随机生成，answer 原样回传） */
  question: {
    requestId: string
    resolve: (answer: unknown) => void
    /** 原始问题定义（超时未答时恢复用） */
    request: any
  } | null
}

export function apply(ctx: any): void {
  const cfg = loadConfig()
  if (!cfg) {
    log("no apiKey config; plugin disabled")
    return
  }
  const directory = resolve(process.cwd())
  log(`loaded: cwd=${directory}`)

  const a2aRuns = new Map<string, A2aRun>()
  /** session id → 该 session 上进行中的 taskId（一个会话同时只跑一个任务轮） */
  const sessionTasks = new Map<string, string>()

  let a2a: NexusA2AClient | null = null
  const a2aEmit = (event: Record<string, unknown>) => a2a?.sendEvent(event)

  // ---------------- dsh 会话锚定（per-caller 复用） ----------------

  /** 取 caller 对应的 live agent；无则新建（cwd = 工作区目录）。 */
  async function anchorSession(caller: string, serverSessionId: string): Promise<{ agent: any; sessionId: string } | null> {
    const map = readSessionMap(directory)
    const candidates: string[] = []
    if (serverSessionId) candidates.push(serverSessionId)
    if (map[caller]) candidates.push(map[caller])
    const agents = (ctx as any).agents
    for (const sid of candidates) {
      if (!sid) continue
      const agent = agents?.get?.(sid)
      if (agent) return { agent, sessionId: sid }
    }
    try {
      const sessionId = randomUUID()
      const handle = await agents.create({
        sessionId,
        meta: { cwd: directory },
      })
      log(`session created ${String(sessionId).slice(0, 12)} (caller=${caller})`)
      return { agent: (handle as any).agent ?? handle, sessionId: String(sessionId) }
    } catch (e) {
      log(`session create failed: ${e}`)
      return null
    }
  }

  // ---------------- 事件 → A2A 上报 ----------------

  /** content[] 提取 text 块拼接 */
  function blockText(content: unknown): string {
    if (!Array.isArray(content)) return ""
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("")
  }

  function finishTask(taskId: string, run: A2aRun, outcome: "completed" | "failed", errorText?: string): void {
    if (!a2aRuns.has(taskId)) return
    a2aRuns.delete(taskId)
    if (sessionTasks.get(run.sessionId) === taskId) sessionTasks.delete(run.sessionId)
    if (run.permission) {
      settlePermission(run, "cancelled")
    }
    if (run.question) {
      settleQuestion(run, null) // 取消/收尾时提问恢复拒绝（agent 已不在等答案）
    }
    const t: A2aTaskRef = { taskId, contextId: taskId }
    if (outcome === "completed") {
      const answer = run.finalText || "(no text output)"
      a2aEmit(artifactUpdate(t, answer, true, `art-${taskId}`))
      a2aEmit(
        statusUpdate(t, "completed", {
          final: true,
          message: agentMessage(answer, t),
          metadata: { session_id: run.sessionId },
        }),
      )
      log(`a2a ${taskId.slice(0, 8)}: completed (${answer.length} chars)`)
    } else {
      a2aEmit(
        statusUpdate(t, "failed", {
          final: true,
          message: agentMessage(errorText ?? "unknown error", t),
          metadata: { session_id: run.sessionId },
        }),
      )
      log(`a2a ${taskId.slice(0, 8)}: failed: ${errorText?.slice(0, 120)}`)
    }
  }

  function handleEvent(taskId: string, run: A2aRun, ev: any): void {
    const task: A2aTaskRef = { taskId, contextId: taskId }
    const type = String(ev?.type ?? "")
    const data = ev?.data ?? {}

    // turn 归属：首个 turn/start 到达时锁定本轮 turn 号；此后只处理该 turn 的事件
    if (type === "turn/start") {
      if (run.claimedTurn === null) {
        run.claimedTurn = Number(data.turn ?? 0)
        log(`a2a ${taskId.slice(0, 8)}: turn ${run.claimedTurn} started`)
      }
      return
    }
    const turn = Number(data.turn ?? -1)
    if (run.claimedTurn !== null && turn >= 0 && turn !== run.claimedTurn) return

    switch (type) {
      case "user/message": {
        if (!run.injected) return // 会话复用时，别人的历史 user 消息不报
        a2aEmit(
          statusUpdate(task, "working", {
            message: {
              role: "user",
              parts: [{ kind: "text", text: blockText(data.content) }],
              messageId: `msg-${taskId}-user`,
              taskId,
              contextId: taskId,
            },
            metadata: { session_id: run.sessionId },
          }),
        )
        break
      }
      case "assistant/attempt": {
        // 持久流快照：stream[] 里 text-delta / reasoning-delta 累计值做全量快照上报
        const stream = Array.isArray(data.stream) ? data.stream : []
        let text = ""
        let reasoning = ""
        for (const rec of stream) {
          if (rec?.type !== "chunk") continue
          const c = rec.chunk ?? {}
          if (c.type === "text-delta") text += String(c.text ?? "")
          else if (c.type === "reasoning-delta") reasoning += String(c.text ?? "")
        }
        if (text.length > run.lastTextLen) {
          run.lastTextLen = text.length
          a2aEmit(streamStatus(task, "text", `${taskId}-text`, text, "replace"))
        }
        if (reasoning.length > run.lastReasoningLen) {
          run.lastReasoningLen = reasoning.length
          a2aEmit(streamStatus(task, "reasoning", `${taskId}-reasoning`, reasoning, "replace"))
        }
        break
      }
      case "tool/call": {
        let input: unknown = data.arguments
        if (typeof input === "string" && input.length > 800) input = input.slice(0, 800) + "…"
        a2aEmit(
          toolStatus(task, {
            callId: String(data.callId ?? ""),
            name: String(data.name ?? ""),
            state: "running",
            input,
          }),
        )
        break
      }
      case "tool/result": {
        const msg = data.message ?? {}
        let output = blockText(msg.content)
        if (output.length > 800) output = output.slice(0, 800) + "…"
        a2aEmit(
          toolStatus(task, {
            callId: String(msg.toolCallId ?? ""),
            name: "",
            state: msg.isError ? "error" : "success",
            output,
          }),
        )
        break
      }
      case "assistant/message": {
        // 步骤收尾：最终文本（completed 时作 artifact）；interrupted 前缀也算
        const t = blockText(data.content)
        if (t) run.finalText = t
        break
      }
      case "approval/asked": {
        if (run.permission) return // 同轮多权限：先只处理一个（第二个等第一个结案）
        const requestId = String(data.id ?? "")
        if (!requestId) return
        run.permission = {
          requestId,
          resolve: () => {}, // 真正的收尾走 settlePermission（通知 waterfall + 事件帧）
        }
        a2aEmit(
          inputRequired(task, "permission", {
            requestId,
            toolName: String(data.toolName ?? ""),
            reason: String(data.reason ?? ""),
          }),
        )
        log(`a2a ${taskId.slice(0, 8)}: permission ${requestId.slice(0, 12)} (${data.toolName ?? ""})`)
        break
      }
      case "approval/decided": {
        // 本地 UI / 其它应答器先答了：撤下远程等待（远程迟到应答失效）
        const p = run.permission
        if (p && String(data.id ?? "") === p.requestId) {
          settlePermission(run, "cancelled")
          a2aEmit(statusUpdate(task, "working", { metadata: { permission_resolved: "local" } }))
        }
        break
      }
      case "turn/end": {
        const reason = String(data?.reason?.kind ?? "")
        if (reason === "completed" || reason === "max-tokens") {
          finishTask(taskId, run, "completed")
        } else if (reason === "error") {
          finishTask(taskId, run, "failed", String(data?.reason?.error?.message ?? "turn error"))
        } else if (reason === "aborted" || reason === "blocked") {
          finishTask(taskId, run, "failed", `turn ${reason}`)
        }
        // interrupted / forked 等其它 reason：不算本轮终结（等插件驱动 continuation 的下一个 turn/end）
        break
      }
      default:
        break
    }
  }

  // ---------------- 单一 session/event 总线 ----------------

  ;(ctx as any).on("session/event", (session: any, ev: any) => {
    const sid = session?.header?.id
    if (!sid) return
    const taskId = sessionTasks.get(sid)
    if (!taskId) return
    const run = a2aRuns.get(taskId)
    if (!run) return
    try {
      handleEvent(taskId, run, ev)
    } catch (e) {
      log(`session/event handler error: ${e}`)
    }
  })
  ;(ctx as any).on("agent/error", (payload: any) => {
    const sid = payload?.agent?.session?.header?.id
    if (!sid) return
    const taskId = sessionTasks.get(sid)
    if (!taskId) return
    const run = a2aRuns.get(taskId)
    if (!run) return
    finishTask(taskId, run, "failed", String(payload?.error?.message ?? payload?.error ?? "agent error"))
  })

  // ---------------- 任务执行主体 ----------------

  function buildTaskPrompt(text: string, caller: string, taskId: string): string {
    const src =
      caller === "nexus-web"
        ? "来自 agent_swarm 网页中枢"
        : caller.startsWith("http")
          ? `来自外部 A2A agent（${caller}）`
          : `来自 agent 工作区 ${caller}`
    return `[agent_swarm 任务 ${taskId.slice(0, 8)}，${src}]\n\n${text}\n\n（完成后用 markdown 总结，系统会自动把最终回答回传给派单方。）`
  }

  async function executeTask(
    task: A2aTaskRef,
    text: string,
    caller: string,
    serverSessionId: string,
    onAccepted?: (sessionId: string) => void,
  ): Promise<string | null> {
    const anchored = await anchorSession(caller, serverSessionId)
    if (!anchored) return null
    const { agent, sessionId } = anchored
    writeSessionEntry(directory, caller, sessionId)

    if (sessionTasks.has(sessionId)) {
      // 同会话上一任务还没收尾：拒绝（服务端保持 queued 等下次派发）
      log(`a2a ${task.taskId.slice(0, 8)}: session busy (${sessionTasks.get(sessionId)?.slice(0, 8)})`)
      return null
    }

    const run: A2aRun = {
      sessionId,
      seqBeforeInject: 0,
      claimedTurn: null,
      injected: false,
      lastTextLen: 0,
      lastReasoningLen: 0,
      finalText: "",
      permission: null,
      question: null,
    }
    a2aRuns.set(task.taskId, run)
    sessionTasks.set(sessionId, task.taskId)

    const message = {
      role: "user",
      content: [{ type: "text", text: buildTaskPrompt(text, caller, task.taskId) }],
      source: { kind: "user" },
    }
    run.injected = true
    if (onAccepted) onAccepted(sessionId) // 接单即 ack：会话已锚定，后续进展走 event 通道
    try {
      agent.followup(message)
    } catch (e) {
      a2aRuns.delete(task.taskId)
      sessionTasks.delete(sessionId)
      a2aEmit(statusUpdate(task, "failed", { final: true, message: agentMessage(String(e), task) }))
      throw e
    }
    return sessionId
  }

  // ---------------- 远程权限应答 ----------------

  function replyPermission(taskId: string, requestId: string, reply: string): void {
    const run = a2aRuns.get(taskId)
    if (!run || !run.permission || run.permission.requestId !== requestId) {
      throw new Error("permission request not pending (already answered?)")
    }
    const outcome = reply === "always" || reply === "once" ? "allowed-once" : "rejected"
    settlePermission(run, outcome)
    a2aEmit(
      statusUpdate({ taskId, contextId: taskId }, "working", {
        metadata: { permission_resolved: "remote", reply },
      }),
    )
    log(`a2a ${taskId.slice(0, 8)}: permission ${requestId.slice(0, 12)} → ${reply}`)
  }

  // ---------------- approval/request 应答器（远程应答桥） ----------------

  // ApprovalService.request 会向 approval/request waterfall 要一个 outcome；
  // 本监听器把「等远程应答」的 promise 接进 waterfall：远程（web/飞书/微信/桌宠）
  // 回复 → settlePermission → 这里把 outcome 返回给 dsh。
  // 本地 UI 先答：dsh 内建 answerer 在 waterfall 里先返回，本监听器不会被问到；
  // 之后 approval/decided 事件到达，handleEvent 撤下远程等待。
  ;(ctx as any).on("approval/request", async (req: any, next: () => Promise<string>) => {
    const sid = req?.agent?.session?.header?.id
    const taskId = sid ? sessionTasks.get(sid) : undefined
    const run = taskId ? a2aRuns.get(taskId) : undefined
    // 非本插件任务轮的权限：交给下游（dsh 内建 UI answerer）
    if (!run || !run.permission) return next()
    // approval/asked 事件可能略晚于 waterfall 派发：等它把 permission 挂上
    for (let i = 0; i < 50 && !run.permission; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!run.permission) return next()
    log(`approval/request: wait remote answer ${run.permission.requestId.slice(0, 12)}`)
    const outcome = await new Promise<string>((resolve) => {
      ;(run as any)._waterfallResolve = resolve
    })
    return outcome
  })

  /** permission 统一收尾：清状态 + 通知 approval/request waterfall */
  function settlePermission(run: A2aRun, outcome: string): void {
    const p = run.permission
    if (!p) return
    run.permission = null
    p.resolve(outcome)
    const wf = (run as any)._waterfallResolve as ((o: string) => void) | undefined
    if (wf) {
      ;(run as any)._waterfallResolve = undefined
      wf(outcome)
    }
  }

  // ---------------- user-questions/request 应答器（提问远程应答桥） ----------------

  // ask_user_question 走 user-questions/request waterfall。本监听器把「等远程
  // 回答」接进 waterfall：远程（web/飞书/微信/桌宠）回答 → settleQuestion →
  // 把 AskUserQuestionAnswer 返回给 dsh。本地 UI 先答：内建 answerer 先返回，
  // 之后 question 状态由 askUserQuestion 的 settle 清理。
  ;(ctx as any).on("user-questions/request", async (req: any, next: () => Promise<any>) => {
    const sid = req?.agent?.session?.header?.id
    const taskId = sid ? sessionTasks.get(sid) : undefined
    const run = taskId ? a2aRuns.get(taskId) : undefined
    // 非本插件任务轮的提问：交给下游（dsh 内建 UI answerer）
    if (!run || run.permission) return next()
    const requestId = randomUUID()
    const task: A2aTaskRef = { taskId: taskId!, contextId: taskId! }
    run.question = {
      requestId,
      resolve: () => {}, // 真正收尾走 settleQuestion
      request: req,
    }
    let resolveWaterfall!: (answer: any) => void
    const answerPromise = new Promise<any>((r) => { resolveWaterfall = r })
    ;(run.question as any)._waterfallResolve = resolveWaterfall
    a2aEmit(
      inputRequired(task, "question", {
        requestId,
        questions: req.questions ?? [],
      }),
    )
    log(`a2a ${taskId!.slice(0, 8)}: question ${requestId.slice(0, 12)} (${req.questions?.length ?? 0} item(s))`)
    return answerPromise
  })

  /** question 统一收尾：清状态 + 通知 waterfall；answer=null=放弃（返回拒绝错误） */
  function settleQuestion(run: A2aRun, answer: unknown): void {
    const q = run.question
    if (!q) return
    run.question = null
    q.resolve(answer)
    const wf = (q as any)._waterfallResolve as ((a: any) => void) | undefined
    if (wf) {
      ;(q as any)._waterfallResolve = undefined
      if (answer === null) {
        // 远程取消/任务收尾：恢复一个干净的拒绝（dsh 侧 ask 抛 NO_PROVIDER 之外的错即可）
        wf(Promise.reject(new Error("question canceled by task teardown")))
      } else {
        wf(answer)
      }
    }
  }

  /** 远程 question 回答入口（WS 续聊 DataPart） */
  function replyQuestion(taskId: string, requestId: string, answers: string[][]): void {
    const run = a2aRuns.get(taskId)
    if (!run || !run.question || run.question.requestId !== requestId) {
      throw new Error("question not pending (already answered?)")
    }
    // answers = [[label, ...], ...]（按问题顺序）；转 dsh AskUserQuestionAnswer
    const questions = (run.question.request?.questions ?? []) as any[]
    const items = questions.map((q, i) => ({
      id: String(q.id ?? `q${i}`),
      selected: answers[i] ?? [],
    }))
    a2aEmit(
      statusUpdate({ taskId, contextId: taskId }, "working", {
        metadata: { question_resolved: "remote" },
      }),
    )
    log(`a2a ${taskId.slice(0, 8)}: question ${requestId.slice(0, 12)} answered (${items.length} item(s))`)
    settleQuestion(run, { answers: items })
  }

  // ---------------- WS 客户端 ----------------

  a2a = startNexusA2AClient({
    url: cfg.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/plugin",
    apiKey: cfg.apiKey,
    workspaceId: () => readWorkspaceId(directory),
    onTask: (task, text, caller, serverSessionId, onAccepted) =>
      executeTask(task, text, caller, serverSessionId ?? "", onAccepted),
    onReply: async (task, data) => {
      if (data.type === "permission") {
        replyPermission(task.taskId, data.requestId, String(data.reply ?? "once"))
      } else if (data.type === "question") {
        replyQuestion(task.taskId, data.requestId, (data.answers ?? []) as string[][])
      } else {
        throw new Error(`unsupported reply type: ${data.type}`)
      }
    },
    onTaskCancel: (taskId) => {
      const run = a2aRuns.get(taskId)
      if (!run) return
      log(`a2a ${taskId.slice(0, 8)}: cancel requested`)
      // 先取消 dsh agent（打断本轮），再收尾任务行
      try {
        const agent = (ctx as any).agents?.get?.(run.sessionId)
        agent?.cancel?.({ kind: "user" })
      } catch (e) {
        log(`cancel agent failed: ${e}`)
      }
      finishTask(taskId, run, "failed", "canceled by caller")
    },
    log,
  })

  // ---------------- /swarm-* 命令（dsh commands 注册表） ----------------

  swarmCommands(ctx, { directory, log })

  // ---------------- 心跳（MCP heartbeat，服务端在线判定 = last_heartbeat 90s 超时） ----------------

  const HEARTBEAT_MS = 30_000
  const swarm = new SwarmHeartbeat(cfg)
  let disposed = false
  ctx.effect?.(() => () => {
    disposed = true
    a2a?.close()
  })

  async function heartbeatLoop() {
    log(`heartbeat loop start (${HEARTBEAT_MS}ms)`)
    while (!disposed) {
      // 每轮重读文件：重新注册/换 ID 后无需重启
      const wid = readWorkspaceId(directory)
      if (wid) {
        // 上报 per-caller 会话中最新的一个（web 有会话名可看；多个时上报最近创建的）
        let sessionId = ""
        for (const run of a2aRuns.values()) sessionId = run.sessionId
        if (!sessionId) {
          const map = readSessionMap(directory)
          sessionId = Object.values(map).at(-1) ?? ""
        }
        try {
          await swarm.heartbeat(wid, sessionId, "")
        } catch (e) {
          log(`heartbeat failed: ${e}`)
        }
      }
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS))
    }
  }
  void heartbeatLoop()

  log("agent-swarm deepseek plugin ready")
}
