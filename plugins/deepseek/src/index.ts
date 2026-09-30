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
import { readWorkspaceList } from "./workspaces.ts"
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
/** Cordis 注入声明：commands（/swarm-* 注册）、agents（会话锚定）。
 * 没有声明就不能访问 ctx.commands/ctx.agents（"cannot get property without inject"）。 */
export const inject = ["commands", "agents"]

/** 从 AssistantStreamRecord[] 提取累计 text / reasoning 文本。
 *  记录是压缩打包形态：{type:"text-chunks"|"reasoning-chunks", texts:string[]}，
 *  少量原始 {type:"chunk", chunk:{type:"text-delta"|"reasoning-delta", text}}。 */
function streamText(stream: unknown): { text: string; reasoning: string } {
  let text = ""
  let reasoning = ""
  if (!Array.isArray(stream)) return { text, reasoning }
  for (const rec of stream) {
    const t = String(rec?.type ?? "")
    if (t === "text-chunks") text += (rec.texts ?? []).join("")
    else if (t === "reasoning-chunks") reasoning += (rec.texts ?? []).join("")
    else if (t === "chunk") {
      const c = rec.chunk ?? {}
      if (c.type === "text-delta") text += String(c.text ?? "")
      else if (c.type === "reasoning-delta") reasoning += String(c.text ?? "")
    }
  }
  return { text, reasoning }
}

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

/** apply 主体（applyInner）：任何抛错都被 apply 包装记日志后重抛 */
function applyInner(ctx: any): void {
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

  // ---------------- dsh 会话锚定（前台=最近活跃会话；后台=per-caller 专属） ----------------

  /** 最近活跃的用户会话：进行中任务优先，其次 seq 最大（事件最多 = 最活跃）。 */
  function mostActiveSession(): { agent: any; sessionId: string } | null {
    const agents = (ctx as any).agents?.list?.() ?? []
    let best: any = null
    let bestScore = -1
    for (const agent of agents) {
      const session = agent?.session
      if (!session?.header?.id) continue
      const score = (sessionTasks.has(session.header.id) ? 1e15 : 0) + Number(session.seq ?? 0)
      if (score > bestScore) {
        bestScore = score
        best = agent
      }
    }
    return best ? { agent: best, sessionId: String(best.session.header.id) } : null
  }

  /** 执行模式（foreground=注入最近活跃会话；background=per-caller 专属会话）。
   * 每次派任务现读：/swarm-mode 热切换立即生效。 */
  function currentMode(): "foreground" | "background" {
    return loadConfig()?.executionMode ?? "foreground"
  }

  async function anchorSession(caller: string, serverSessionId: string): Promise<{ agent: any; sessionId: string } | null> {
    const agents = (ctx as any).agents
    // 前台模式：注入最近活跃会话（所见即所得，对齐 opencode 前台注入）
    if (currentMode() === "foreground") {
      const active = mostActiveSession()
      if (active) return active
      log(`foreground: no live session, falling back to create (caller=${caller})`)
    }
    // 后台模式（或前台无活跃会话兜底）：per-caller 专属会话
    const map = readSessionMap(directory)
    const candidates: string[] = []
    if (serverSessionId) candidates.push(serverSessionId)
    if (map[caller]) candidates.push(map[caller])
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
        // 持久流快照：stream[] 里累计文本做全量快照上报
        log(`a2a ${taskId.slice(0, 8)}: attempt received (turn=${turn})`)
        const { text, reasoning } = streamText(data.stream)
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
        // 步骤收尾：最终文本（completed 时作 artifact）；interrupted 前缀也算。
        // payload = { message: AssistantMessage, stream }——文本在 data.message.content
        log(`a2a ${taskId.slice(0, 8)}: message received (turn=${turn})`)
        const t = blockText(data.message?.content) || blockText(data.content)
        if (t) run.finalText = t
        // 宿主根监听收不到 assistant/attempt（实测只有持久事件可达）——
        // 从 message 附带的 stream 快照补 reasoning/text 流式上报
        const { text, reasoning } = streamText(data.stream)
        if (reasoning.length > run.lastReasoningLen) {
          run.lastReasoningLen = reasoning.length
          a2aEmit(streamStatus(task, "reasoning", `${taskId}-reasoning`, reasoning, "replace"))
        }
        if (text.length > run.lastTextLen) {
          run.lastTextLen = text.length
          a2aEmit(streamStatus(task, "text", `${taskId}-text`, text, "replace"))
        }
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

  // ---------------- 监控模式（用户日常对话轮次实时上报中枢） ----------------

  /** 监控轮状态（session id → 当前轮）。一个会话同时只有一个前台轮，新一轮自动顶掉旧轮。 */
  interface MonRound {
    roundKey: string
    /** 累计的最终 assistant 文本（turn/end 时作 idle 的回答） */
    finalText: string
  }
  const monRounds = new Map<string, MonRound>()

  /** 监控轮待应答权限：session id → {requestId, resolve}（roundKey 可从 monRounds 反查） */
  const monPerms = new Map<string, { requestId: string; resolve: (outcome: string) => void }>()

  function monEmit(roundKey: string, sid: string, payload: Record<string, unknown>): void {
    a2a?.sendMonitor({ roundKey, sessionId: sid, ...payload })
  }

  /** 监控事件（用户消息/thinking/工具/回答/权限/提问/轮收尾）。
   *  轮次边界：user/message 开轮 → turn/end 收轮（对齐 opencode 插件的 monitor 管道）。 */
  function handleMonitorEvent(session: any, ev: any): void {
    const sid = session?.header?.id
    if (!sid) return
    const type = String(ev?.type ?? "")
    const data = ev?.data ?? {}
    const seq = Number(ev?.seq ?? 0)

    // 只监控本项目目录的会话（多项目共存时其它项目的会话不属于任何已注册工作区）
    const cwd = String(session?.header?.cwd ?? "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase()
    const knownDirs = readWorkspaceList().map((e) => e.directory.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase())
    if (cwd && !knownDirs.includes(cwd)) return

    if (type !== "user/message" && type !== "assistant/attempt" && type !== "turn/end") {
      log(`monitor evt: ${type} seq=${seq}`)
    }

    if (type === "user/message") {
      // 用户提问 = 开新轮（旧轮自动被服务端 superseded）
      const text = blockText(data.content).slice(0, 8000)
      const roundKey = `mon-${sid.slice(0, 8)}-${String(ev.seq ?? Date.now()).slice(-12)}`
      monRounds.set(sid, { roundKey, finalText: "" })
      monEmit(roundKey, sid, { type: "user", text: "", seq })
      if (text.trim()) monEmit(roundKey, sid, { type: "user-text", text })
      log(`monitor ${roundKey}: opened (${text.length} chars)`)
      return
    }

    const round = monRounds.get(sid)
    if (!round) return // 轮未开（assistant part 先于 user 的乱序保护）

    switch (type) {
      case "assistant/attempt": {
        const stream = Array.isArray(data.stream) ? data.stream : []
        const { text, reasoning } = streamText(data.stream)
        log(`monitor ${round.roundKey}: attempt text=${text.length} reasoning=${reasoning.length}`)
        if (reasoning.trim()) monEmit(round.roundKey, sid, { type: "reasoning", partId: `mon-${sid.slice(0, 6)}-r`, text: reasoning })
        if (text.trim()) monEmit(round.roundKey, sid, { type: "text", partId: `mon-${sid.slice(0, 6)}-t`, text })
        break
      }
      case "assistant/message": {
        // payload = { message: AssistantMessage, stream }——文本在 data.message.content
        const t = blockText(data.message?.content) || blockText(data.content)
        if (t) round.finalText = t
        // 宿主根监听收不到 assistant/attempt——从 stream 快照补 thinking/text 帧
        const { text: mtext, reasoning: mreasoning } = streamText(data.stream)
        if (mreasoning.trim()) monEmit(round.roundKey, sid, { type: "reasoning", partId: `mon-${sid.slice(0, 6)}-r`, text: mreasoning })
        if (mtext.trim()) monEmit(round.roundKey, sid, { type: "text", partId: `mon-${sid.slice(0, 6)}-t`, text: mtext })
        break
      }
      case "tool/call": {
        let input: unknown = data.arguments
        if (typeof input === "string" && input.length > 500) input = input.slice(0, 500) + "…"
        monEmit(round.roundKey, sid, {
          type: "tool", tool: String(data.name ?? ""), toolState: "running",
          callId: String(data.callId ?? ""), input,
        })
        break
      }
      case "tool/result": {
        const msg = data.message ?? {}
        let output = blockText(msg.content)
        if (output.length > 500) output = output.slice(0, 500) + "…"
        monEmit(round.roundKey, sid, {
          type: "tool", tool: "", toolState: msg.isError ? "error" : "success",
          callId: String(msg.toolCallId ?? ""), output,
        })
        break
      }
      case "approval/asked": {
        const requestId = String(data.id ?? "")
        if (requestId) {
          // 监控轮权限：挂 pending（远程应答桥用），turn/end / decided 时撤下
          monPerms.set(sid, { requestId, resolve: () => {} })
        }
        monEmit(round.roundKey, sid, {
          type: "permission", requestId,
          permission: String(data.toolName ?? ""), title: String(data.reason ?? ""),
          patterns: [],
        })
        break
      }
      case "approval/decided": {
        // 本地 UI 先答了：撤下监控轮的远程等待
        const mp = monPerms.get(sid)
        if (mp && String(data.id ?? "") === mp.requestId) {
          monPerms.delete(sid)
          monEmit(round.roundKey, sid, { type: "replied" })
        }
        break
      }
      case "turn/end": {
        const reason = String(data?.reason?.kind ?? "")
        if (reason === "completed" || reason === "max-tokens" || reason === "aborted" || reason === "error") {
          const mp = monPerms.get(sid)
          if (mp && mp.requestId) {
            // 未应答即收轮：撤下等待（对齐 opencode idle 收轮语义）
            mp.resolve("cancelled")
            monPerms.delete(sid)
          }
          log(`monitor ${round.roundKey}: idle (${reason}) finalText=${round.finalText.length} chars`)
          monEmit(round.roundKey, sid, {
            type: "idle", reason,
            text: round.finalText,
          })
          monRounds.delete(sid)
        }
        break
      }
      default:
        break
    }
  }

  // ---------------- 单一 session/event 总线 ----------------

  /** 防御性事件注册：ctx.on 缺失/抛错只降级不拖死插件（options 透传，如 { prepend: true }） */
  function safeOn(event: string, handler: (...args: any[]) => any, options?: Record<string, unknown>): boolean {
    try {
      if (typeof ctx.on !== "function") {
        log(`ctx.on unavailable; ${event} listener skipped`)
        return false
      }
      ctx.on(event, handler, options)
      return true
    } catch (e) {
      log(`${event} listener register failed: ${e}`)
      return false
    }
  }

  safeOn("session/event", (session: any, ev: any) => {
    const sid = session?.header?.id
    if (!sid) return
    const taskId = sessionTasks.get(sid)
    if (taskId) {
      const run = a2aRuns.get(taskId)
      if (run) {
        try {
          handleEvent(taskId, run, ev)
        } catch (e) {
          log(`session/event handler error: ${e}`)
        }
        return
      }
    }
    // 非任务轮 → 监控层（用户日常对话轮次实时上报中枢）
    try {
      handleMonitorEvent(session, ev)
    } catch (e) {
      log(`monitor handler error: ${e}`)
    }
  })
  safeOn("agent/error", (payload: any) => {
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

    // 手构 UserMessage 必须带稳定 id（dsh Session.append 校验 identified message；
    // createUserMessage 的话就是 randomUUID + deepFreeze）
    const message = {
      id: randomUUID(),
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
    const outcome = reply === "always" || reply === "once" ? "allowed-once" : "rejected"
    // 监控轮应答（taskId = roundKey）：按 requestId 反查 monPerms。查不到 = 本地 UI
    // 已先答（waterfall 收尾已清 monPerms）——幂等返回，让服务端撤下待应答即可。
    for (const [sid, mp] of monPerms) {
      if (mp.requestId === requestId) {
        monPerms.delete(sid)
        mp.resolve(outcome)
        const round = monRounds.get(sid)
        if (round) monEmit(round.roundKey, sid, { type: "replied" })
        log(`monitor ${round?.roundKey.slice(0, 16) ?? sid.slice(0, 8)}: permission ${requestId.slice(0, 12)} → ${reply} (remote)`)
        return
      }
    }
    const run = a2aRuns.get(taskId)
    if (!run || !run.permission || run.permission.requestId !== requestId) {
      log(`a2a reply ${taskId.slice(0, 8)}: permission ${requestId.slice(0, 12)} already settled (local won)`)
      return
    }
    settlePermission(run, outcome)
    a2aEmit(
      statusUpdate({ taskId, contextId: taskId }, "working", {
        metadata: { permission_resolved: "remote", reply },
      }),
    )
    log(`a2a ${taskId.slice(0, 8)}: permission ${requestId.slice(0, 12)} → ${reply}`)
  }

  // ---------------- approval/request 应答器（远程应答桥，先答先算） ----------------

  // waterfall 顺序：api-remotes 的 Remote 桥（桌面/web UI 的 answerer）注册在宿主启动期，
  // 排在我们前面——它接到请求会挂给浏览器面板且在本地应答前不 next()，我们永远轮不到。
  // 因此必须 prepend 抢队头；但抢到后不能独占等待（本地 UI 就答不了）：
  // 立刻 next() 放行下游，远程/本地谁先 settle 用谁（先答先算，对齐虫群跨渠道语义）。
  // 下游返回 unavailable（无 UI 在听）不算应答，继续等远程。
  // 不设超时：没人应答就一直等（用户可在本地打断会话，signal abort → cancelled）。
  safeOn(
    "approval/request",
    async (req: any, next: () => Promise<string>) => {
      const sid = req?.agent?.session?.header?.id
      if (!sid) return next()
      const taskId = sessionTasks.get(sid)
      const run = taskId ? a2aRuns.get(taskId) : undefined
      // approval/asked 在 decide() 前同步 append，通常已挂上；兜底等 5s
      const waitAttach = async (has: () => boolean) => {
        for (let i = 0; i < 50 && !has(); i++) {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      let remote: Promise<string> | null = null
      if (run) {
        await waitAttach(() => !!run.permission)
        if (!run.permission) return next()
        log(`approval/request: wait answer (task) ${run.permission.requestId.slice(0, 12)}`)
        remote = new Promise<string>((resolve) => {
          ;(run as any)._waterfallResolve = resolve
        })
      } else {
        await waitAttach(() => monPerms.has(sid))
        const mp = monPerms.get(sid)
        if (!mp) return next()
        log(`approval/request: wait answer (monitor) ${mp.requestId.slice(0, 12)}`)
        remote = new Promise<string>((resolve) => {
          mp.resolve = resolve
        })
      }
      // 下游（本地 UI / Remote 桥）：unavailable = 无 UI 在听，映射成永不 settle 继续等远程
      const local = next().catch(() => "unavailable")
      const localReal = local.then((o) =>
        o === "unavailable" ? new Promise<never>(() => {}) : o,
      )
      // 工具调用被中止（本地打断会话/请求方取消）→ cancelled
      const aborted = new Promise<string>((resolve) => {
        req?.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true })
      })
      const outcome = await Promise.race([remote, localReal, aborted])
      // 收尾幂等：远程先答时 replyPermission 已清过状态，这里 no-op；本地先答时清残留
      // 并通知中枢撤下等待（replied 帧），web/飞书/微信的待应答卡随之关闭。
      if (run) {
        settlePermission(run, outcome)
      } else {
        monPerms.delete(sid)
        const round = monRounds.get(sid)
        if (round) monEmit(round.roundKey, sid, { type: "replied" })
      }
      return outcome
    },
    { prepend: true },
  )

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
  safeOn("user-questions/request", async (req: any, next: () => Promise<any>) => {
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
    // WS 连接的工作区：清单第一条（dsh 宿主 cwd 是 profile 目录，readWorkspaceId(cwd)
    // 永远空——hello 需要一个 wid 才能注册连接；清单由 /swarm-add 维护）
    workspaceId: () => readWorkspaceList()[0]?.workspaceId ?? readWorkspaceId(directory),
    executionMode: () => currentMode(),
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

  try {
    swarmCommands(ctx, { directory, log })
  } catch (e) {
    log(`swarmCommands setup failed: ${e}`)
  }

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
    const lastReport = new Map<string, string>()
    while (!disposed) {
      // 每轮重读清单：/swarm-add|remove 后无需重启（dsh 宿主 cwd 是 profile 目录，
      // 工作区靠全局清单 agent-swarm-workspaces.json 记账，逐个心跳上报）
      const entries = readWorkspaceList()
      if (entries.length === 0) {
        // 没有任何注册工作区：心跳 profile 目录自己的 workspace.md（兼容手写场景）
        const legacy = readWorkspaceId(directory)
        if (legacy) entries.push({ workspaceId: legacy, directory })
      }
      for (const entry of entries) {
        try {
          // 上报最近活跃会话（前台注入目标 = 同一个，中枢所见即所得）。
          // 标题 = 首个 user 消息首行（对齐 dsh session-title 的 fallback 逻辑）。
          const agents = (ctx as any).agents?.list?.() ?? []
          const norm = (p: unknown) => String(p ?? "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase()
          const targetDir = norm(entry.directory)
          let best: { id: string; title: string; score: number } | null = null
          let candidateCount = 0
          for (const agent of agents) {
            const session = agent?.session
            if (!session?.header?.id) continue
            candidateCount++
            // 只上报属于该项目目录的会话（cwd 归一化后匹配；无 cwd 的会话也算候选，
            // dsh 手开会话 header.cwd 理论上总有值）
            const cwd = norm(session.header.cwd)
            if (cwd && targetDir && cwd !== targetDir) continue
            let title = ""
            try {
              // 优先取重命名标题（session/title 事件，dsh session-title 插件落库）；
              // 没有再回退首条 user 消息首行（对齐 dsh session-title 的 fallback 逻辑）
              for (let seq = Number(session.seq ?? 0) - 1; seq >= 0; seq--) {
                const ev = session.eventAt?.(seq)
                if (ev?.type === "session/title" && typeof ev.data?.title === "string" && ev.data.title.trim()) {
                  title = ev.data.title.trim().slice(0, 60)
                  break
                }
              }
              if (!title) {
                const msgs = session.deriveMessages?.() ?? []
                for (const m of msgs) {
                  if ((m as any).role !== "user") continue
                  const block = Array.isArray((m as any).content) ? (m as any).content : []
                  const t = block.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join(" ")
                  if (t.trim()) { title = t.trim().split("\n")[0].slice(0, 60); break }
                }
              }
            } catch { /* 投影读失败不阻塞心跳 */ }
            const running = sessionTasks.get(session.header.id)
            const score = (running ? 1e15 : 0) + Number(session.seq ?? 0)
            if (!best || score > best.score) best = { id: session.header.id, title, score }
          }
          const sessionId = best?.id ?? ""
          const title = best?.title ?? ""
          if (sessionId !== lastReport.get(entry.workspaceId)) {
            log(`heartbeat ${entry.workspaceId.slice(0, 8)}: agents=${agents.length} candidates=${candidateCount} session=${sessionId.slice(0, 20)} title=${title.slice(0, 30)}`)
            lastReport.set(entry.workspaceId, sessionId)
          }
          await swarm.heartbeat(entry.workspaceId, sessionId, title)
        } catch (e) {
          log(`heartbeat ${entry.workspaceId.slice(0, 8)} failed: ${e}`)
        }
      }
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS))
    }
  }
  void heartbeatLoop()

  log("agent-swarm deepseek plugin ready")
}

/** 导出入口：包一层崩溃日志（dsh UI 只显示"启动失败"，原因只有这里能落） */
export function apply(ctx: any): void {
  try {
    applyInner(ctx)
  } catch (e) {
    log(`apply CRASHED: ${e}\n${(e as Error)?.stack ?? ""}`)
    throw e
  }
}
