/** agent_swarm opencode V2 插件：心跳保活 + A2A 任务执行 + 前台监控。
 *
 * V2 与 V1 的差异（实测 opencode 2.0.15）：
 *   - 入口：Plugin.define({ id, setup(ctx) })，directory 取 ctx.location.directory，
 *     清理由 setup 返回的 cleanup 承担（V1 是返回 { event, dispose }）
 *   - 事件：ctx.event.subscribe() 异步流（V1 是返回 event 钩子），且是**强类型命名事件**：
 *       session.inbox.enqueued  → 用户提问（item.payload.text 自带文本，含 delivery）
 *       session.text.delta/ended、session.reasoning.delta/ended → 回答/思考（ending 带全量）
 *       session.tool.input.started（带 name）/called/success/failed → 工具
 *       session.execution.succeeded/failed/interrupted → 一轮结束（不是 session.idle）
 *       permission.asked、form.created、session.error
 *   - 读消息：ctx.session.context({ sessionID })（等价 session.messages）
 *   - 注任务：ctx.session.prompt({ sessionID, text, delivery })（等价 promptAsync）
 *   - 权限应答：ctx.permission.reply({ sessionID, requestID, decision })
 *   - 提问：V2 改叫 form，但 server 插件 ctx 没有 session.form（只有 TUI 插件有），
 *     本版「只上报、不应答」——用户决策 2026-09-23（先上线，后续按 V2 兼容问题反馈）
 *   - ctx.session 没有 list：会话靠事件里的 sessionID 跟踪（心跳上报），不再挑最近会话
 */

import type { Context, Plugin as PluginDef } from "@opencode/plugin/promise/plugin"
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readWorkspaceId } from "../wsfile"
import { readSessionMap, writeSessionEntry } from "../sessions"
import { loadConfig } from "../config"
import { runBackgroundTask } from "./background"
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
} from "../nexus_a2a"

const LOG_FILE = join(homedir(), ".config", "opencode", "plugins", "agent-swarm", "plugin.log")
const LOG_MAX_BYTES = 1_000_000

function log(msg: string) {
  try {
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

interface V2Evt {
  type?: string
  data?: Record<string, any>
}

// ---------------- 会话消息提取（V2 形状：消息有 type=user/assistant，assistant 有 content[]） ----------------

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const t = content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim())
    .map((c: any) => c.text.trim())
    .join("\n")
  return t || undefined
}

function assistantText(m: any): string {
  return contentText(m?.content) ?? ""
}

function lastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type !== "assistant") continue
    const t = assistantText(messages[i])
    if (t) return t
  }
  return ""
}

function lastAssistantId(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === "assistant") return String(messages[i].id ?? "")
  }
  return ""
}

/** 只取 afterId 之后的 assistant 文本（任务轮 artifact 不回退到上一轮） */
function assistantTextAfter(messages: any[], afterId: string): string {
  if (!afterId) return lastAssistantText(messages)
  let start = -1
  for (let i = 0; i < messages.length; i++) {
    if (String(messages[i]?.id ?? "") === afterId) {
      start = i
      break
    }
  }
  if (start < 0) return lastAssistantText(messages)
  return lastAssistantText(messages.slice(start + 1))
}

// opencode 的 Plugin.define 只是恒等函数；这里直接导出对象，避免运行时裸导入
// @opencode/plugin（配置目录下的插件在 opencode 加载器里解析不到它，实测）。
const plugin: PluginDef = {
  id: "agent-swarm",
  async setup(ctx: Context) {
    const directory = ctx.location?.directory ?? process.cwd()
    const cfg = loadConfig()
    if (!cfg) {
      log("v2: no apiKey config; plugin disabled")
      return
    }
    const config = cfg // 闭包内使用（TS 收窄在嵌套函数里失效，固定非空引用）
    // 注意：**心跳/在线判定不在这里** —— 本插件由 service 按 location 常驻加载，
    // 若在此心跳，凡是 service 加载过的项目（哪怕没开 TUI）都会 online（用户实测问题）。
    // 在线改由 CLI 插件（TUI 进程，src/v2/tui.ts）心跳：开着 TUI 才在线。

    let currentSessionId = ""
    let stopped = false
    let nexus: NexusA2AClient | null = null
    /** 本 location 见过的会话（只信自己事件流里的；服务端下发的 session_id 可能是脏的） */
    const seenSessions = new Set<string>()
    const locTag = directory.split(/[\\/]/).filter(Boolean).pop() ?? directory

    interface A2aRun {
      sessionId: string
      injected: boolean
      lastAssistantIdBefore: string
      inputSeen: Set<string>
    }
    const a2aRuns = new Map<string, A2aRun>()

    interface MonRound {
      roundKey: string
      inputSeen: Set<string>
    }
    const monRounds = new Map<string, MonRound>()
    /** 工具 callId → 工具名（session.tool.input.started 带 name） */
    const toolNames = new Map<string, string>()
    /** 权限/提问 requestId → 所属 session（应答按它路由） */
    const inputSession = new Map<string, string>()

    function a2aEmit(event: Record<string, unknown>) {
      nexus?.send({ type: "event", payload: event })
    }
    function monitorEmit(payload: Record<string, unknown>) {
      nexus?.sendMonitor(payload)
    }

    async function contextMessages(sessionId: string): Promise<any[]> {
      try {
        const rsp: any = await ctx.session.context({ sessionID: sessionId })
        return Array.isArray(rsp) ? rsp : []
      } catch {
        return []
      }
    }

    /** 该会话是否属于本 location（服务端下发的 session_id 可能是脏数据） */
    async function ownsSession(sessionId: string): Promise<boolean> {
      if (!sessionId) return false
      if (seenSessions.has(sessionId)) return true
      try {
        const s: any = await ctx.session.get({ sessionID: sessionId })
        return String(s?.location?.directory ?? "") === directory
      } catch {
        return false
      }
    }

    function a2aRunFor(sid: string): [string, A2aRun] | undefined {
      for (const entry of a2aRuns.entries()) if (entry[1].sessionId === sid) return entry
      return undefined
    }

    // ---------------- 事件 → 文本/思考/工具 ----------------

    function emitStream(sid: string, kind: "text" | "reasoning", partId: string, text: string, mode: "replace" | "append") {
      const run = a2aRunFor(sid)
      if (run) {
        a2aEmit(streamStatus({ taskId: run[0], contextId: run[0] }, kind, partId, text, mode))
        return
      }
      const round = monRounds.get(sid)
      if (round) monitorEmit({ roundKey: round.roundKey, sessionId: sid, type: kind, partId, text })
    }

    function emitTool(
      sid: string,
      ev: { callId: string; name: string; state: "running" | "completed" | "error"; input?: unknown; output?: string },
    ) {
      const run = a2aRunFor(sid)
      if (run) {
        a2aEmit(toolStatus({ taskId: run[0], contextId: run[0] }, ev))
        return
      }
      const round = monRounds.get(sid)
      if (round) {
        monitorEmit({
          roundKey: round.roundKey,
          sessionId: sid,
          type: "tool",
          tool: ev.name,
          toolState: ev.state,
          callId: ev.callId,
          input: ev.input,
          output: ev.output,
        })
      }
    }

    /** 打开监控轮：inbox.enqueued 自带提问文本 */
    function openRound(sid: string, seed: string, userText: string) {
      const roundKey = `mon-${sid.slice(0, 8)}-${seed.slice(-12)}`
      monRounds.set(sid, { roundKey, inputSeen: new Set() })
      monitorEmit({ roundKey, sessionId: sid, type: "user", text: "", messageId: seed })
      if (userText.trim()) {
        monitorEmit({ roundKey, sessionId: sid, type: "user-text", text: userText.slice(0, 8000) })
        log(`monitor ${roundKey}: question (${userText.length} chars)`)
      }
    }

    function reportPermission(sid: string, d: Record<string, any>) {
      const requestId = String(d.id ?? "")
      if (!requestId) return
      inputSession.set(requestId, sid)
      const payload = {
        requestId,
        sessionId: sid,
        permission: String(d.action ?? "unknown"),
        title: String(d.message ?? ""),
        patterns: Array.isArray(d.resources) ? d.resources.map(String) : [],
      }
      const run = a2aRunFor(sid)
      if (run && !run[1].inputSeen.has(requestId)) {
        run[1].inputSeen.add(requestId)
        a2aEmit(inputRequired({ taskId: run[0], contextId: run[0] }, "permission", payload))
      }
      const round = monRounds.get(sid)
      if (round && !round.inputSeen.has(requestId)) {
        round.inputSeen.add(requestId)
        monitorEmit({ roundKey: round.roundKey, type: "permission", ...payload })
      }
    }

    /** 提问（V2 form）：只上报，不应答（server 插件无 session.form） */
    function reportForm(sid: string, form: Record<string, any>) {
      const formId = String(form?.id ?? "")
      if (!formId) return
      inputSession.set(formId, sid)
      const payload = {
        requestId: formId,
        sessionId: sid,
        question: String(form?.title ?? "请选择"),
        options: [] as Array<{ label: string; value: string }>,
        unsupported_v2: true,
      }
      const run = a2aRunFor(sid)
      if (run && !run[1].inputSeen.has(formId)) {
        run[1].inputSeen.add(formId)
        a2aEmit(inputRequired({ taskId: run[0], contextId: run[0] }, "question", payload))
      }
      const round = monRounds.get(sid)
      if (round && !round.inputSeen.has(formId)) {
        round.inputSeen.add(formId)
        monitorEmit({ roundKey: round.roundKey, type: "question", ...payload })
      }
      log(`form ${formId.slice(0, 12)}: reported only (V2 server plugin cannot reply forms)`)
    }

    /** 一轮结束：A2A 回传 artifact + 终态；监控轮发 idle。完成后清表（防重复收尾） */
    async function finishRound(sid: string, state: "completed" | "failed" | "canceled") {
      const run = a2aRunFor(sid)
      const round = monRounds.get(sid)
      if (round) {
        monRounds.delete(sid)
        monitorEmit({ roundKey: round.roundKey, sessionId: sid, type: "idle" })
      }
      if (!run || !run[1].injected) return
      a2aRuns.delete(run[0])
      const task: A2aTaskRef = { taskId: run[0], contextId: run[0] }
      if (state !== "completed") {
        a2aEmit(statusUpdate(task, state, { final: true, message: agentMessage(`执行${state === "canceled" ? "被取消" : "失败"}`, task), metadata: { session_id: sid } }))
        log(`a2a ${run[0].slice(0, 8)}: ${state}`)
        return
      }
      try {
        await new Promise((r) => setTimeout(r, 800))
        const msgs = await contextMessages(sid)
        const text = assistantTextAfter(msgs, run[1].lastAssistantIdBefore)
        if (text) {
          a2aEmit(artifactUpdate(task, text, true, `artifact-${run[0]}`))
          a2aEmit(statusUpdate(task, "completed", { final: true, metadata: { session_id: sid } }))
          log(`a2a ${run[0].slice(0, 8)}: completed (${text.length} chars)`)
        } else {
          a2aEmit(statusUpdate(task, "failed", { final: true, message: agentMessage("执行超时或未产生结果", task), metadata: { session_id: sid } }))
          log(`a2a ${run[0].slice(0, 8)}: failed (no result text)`)
        }
      } catch (e) {
        a2aEmit(statusUpdate(task, "failed", { final: true, message: agentMessage(`插件执行失败: ${e}`, task) }))
      }
    }

    // ---------------- 任务执行：前台注入 ----------------

    function buildTaskPrompt(text: string, caller: string, taskId: string): string {
      return [
        `[agent_swarm A2A 任务 task_id=${taskId}，来自 ${caller}]`,
        "",
        "任务指令：",
        text,
        "",
        "处理要求：",
        "1. 在当前工作区中完成上述任务（查看代码/修改代码/回答问题）。",
        "2. 完成后用一段话总结结果（做了什么/结论/改动点），系统会自动把总结回传给调用方，不要调用任何工具回传。",
        "3. 无法完成时，直接说明原因即可。",
      ].join("\n")
    }

    async function executeTask(
      task: A2aTaskRef,
      text: string,
      caller: string,
      serverSessionId = "",
      onAccepted?: (sessionId: string) => void,
    ): Promise<string | null> {
      // 每个任务重读配置：/swarm-mode 切换执行模式无需重启
      const live = loadConfig() ?? config
      if (live.executionMode === "background") {
        // 后台模式：spawn headless opencode 进程（V2 不需要 --pure——插件由 service 加载，
        // run 只是客户端）。会话按来源映射表续聊；不碰前台会话。
        const resume = readSessionMap(directory)[caller] ?? ""
        log(`a2a ${task.taskId.slice(0, 8)}: background mode${resume ? ` (resume ${resume.slice(0, 12)})` : " (new session)"} caller=${caller}`)
        onAccepted?.("background") // spawn 已接受（秒级决策），不等进程退出
        const result = await runBackgroundTask(
          task,
          text,
          caller,
          {
            cwd: directory,
            opencodeBin: live.backgroundCommand === "auto" ? "opencode" : live.backgroundCommand,
            resumeSessionId: resume,
          },
          { emit: a2aEmit, log },
        )
        if (result.sessionId) writeSessionEntry(directory, caller, result.sessionId)
        return result.ok ? (result.sessionId ?? "background") : null
      }
      // 服务端下发的 session_id 可能是别 location 的（历史脏数据）：用 session.get 的
      // location.directory 校验归属，通过才用；否则退回本 location 当前会话，再不行新建。
      const serverOwned = serverSessionId ? await ownsSession(serverSessionId) : false
      if (serverSessionId && !serverOwned) {
        log(`a2a ${task.taskId.slice(0, 8)}: ignore foreign serverSessionId ${serverSessionId.slice(0, 14)}`)
      }
      let sessionId = (serverOwned ? serverSessionId : "") || currentSessionId
      if (!sessionId) {
        try {
          const created: any = await ctx.session.create({ title: `A2A-${task.taskId.slice(0, 8)}` })
          sessionId = String(created?.id ?? "")
        } catch (e) {
          log(`a2a ${task.taskId.slice(0, 8)}: create session failed: ${e}`)
        }
      }
      if (!sessionId) return null

      let lastAssistantIdBefore = ""
      try {
        lastAssistantIdBefore = lastAssistantId(await contextMessages(sessionId))
      } catch {
        /* 快照失败不阻塞注入 */
      }
      a2aRuns.set(task.taskId, { sessionId, injected: false, lastAssistantIdBefore, inputSeen: new Set() })
      log(`a2a ${task.taskId.slice(0, 8)}: session ${sessionId}`)
      onAccepted?.(sessionId) // 接单即回 ack：服务端只等 30s，不能等整轮结束

      a2aEmit(
        statusUpdate(task, "working", {
          message: {
            role: "user",
            parts: [{ kind: "text", text }],
            messageId: `msg-${task.taskId}-user`,
            taskId: task.taskId,
            contextId: task.contextId,
          },
          metadata: { session_id: sessionId },
        }),
      )

      try {
        // V2 的 session.prompt 会等到**整轮结束**才 resolve，而 execution.succeeded
        // 在轮次结束时就会到达；因此注入前就标记 injected，否则收尾时永远看到 false
        const run = a2aRuns.get(task.taskId)
        if (run) run.injected = true
        await ctx.session.prompt({ sessionID: sessionId, text: buildTaskPrompt(text, caller, task.taskId), delivery: "steer" })
      } catch (e) {
        a2aEmit(statusUpdate(task, "failed", { final: true, message: agentMessage(String(e), task) }))
        a2aRuns.delete(task.taskId)
        throw e
      }
      return sessionId
    }

    // ---------------- 事件分流 ----------------

    function handleEvent(e: V2Evt) {
      const type = String(e.type ?? "")
      const d = (e.data ?? {}) as Record<string, any>
      const sid = String(d.sessionID ?? "")

      // ctx.event.subscribe() 是**全局事件流**：同一 service 里每个 location 的插件实例
      // 都会收到所有 location 的事件（含订阅时的历史回放）。按 location 过滤；
      // 无 location 的事件（实测 session.execution.* / 回放）只接受本实例已知的会话。
      const loc = (e as any).location?.directory
      if (typeof loc === "string") {
        if (loc !== directory) return
      } else {
        if (!sid) return
        if (sid !== currentSessionId && !a2aRunFor(sid) && !monRounds.has(sid)) return
      }

      // 跟踪当前会话（V2 无 session.list，靠事件跟踪）+ 上报给服务端做应答路由
      if (sid && sid !== currentSessionId) {
        currentSessionId = sid
        seenSessions.add(sid)
        log(`v2 session[${locTag}]: ${sid}`)
        nexus?.sendSession(sid)
      } else if (sid) {
        seenSessions.add(sid)
      }

      switch (type) {
        case "session.inbox.enqueued": {
          const text = String(d.item?.payload?.text ?? "")
          if (sid && !a2aRunFor(sid) && !monRounds.has(sid)) openRound(sid, String(d.inboxID ?? sid), text)
          break
        }
        case "session.tool.input.started":
          toolNames.set(String(d.id ?? ""), String(d.name ?? "unknown"))
          break
        case "session.tool.called":
          emitTool(sid, { callId: String(d.id ?? ""), name: toolNames.get(String(d.id ?? "")) ?? "unknown", state: "running", input: d.input })
          break
        case "session.tool.success":
          emitTool(sid, {
            callId: String(d.id ?? ""),
            name: toolNames.get(String(d.id ?? "")) ?? "unknown",
            state: "completed",
            output: contentText(d.content),
          })
          break
        case "session.tool.failed":
          emitTool(sid, {
            callId: String(d.id ?? ""),
            name: toolNames.get(String(d.id ?? "")) ?? "unknown",
            state: "error",
            output: String(d.error?.message ?? d.error ?? "tool error"),
          })
          break
        case "session.text.delta":
          if (sid && d.delta) emitStream(sid, "text", `${d.assistantMessageID}:${d.ordinal}`, String(d.delta), "append")
          break
        case "session.text.ended":
          if (sid && d.text) emitStream(sid, "text", `${d.assistantMessageID}:${d.ordinal}`, String(d.text), "replace")
          break
        case "session.reasoning.delta":
          if (sid && d.delta) emitStream(sid, "reasoning", `${d.assistantMessageID}:${d.ordinal}`, String(d.delta), "append")
          break
        case "session.reasoning.ended":
          if (sid && d.text) emitStream(sid, "reasoning", `${d.assistantMessageID}:${d.ordinal}`, String(d.text), "replace")
          break
        case "permission.asked":
          if (sid) reportPermission(sid, d)
          break
        case "form.created":
          if (sid) reportForm(sid, (d.form ?? d) as Record<string, any>)
          break
        case "session.error": {
          const run = a2aRunFor(sid)
          if (run) {
            const msg = String(d.error?.message ?? d.error ?? d.message ?? "unknown error")
            a2aRuns.delete(run[0])
            const task: A2aTaskRef = { taskId: run[0], contextId: run[0] }
            a2aEmit(statusUpdate(task, "failed", { final: true, message: agentMessage(msg, task) }))
          }
          break
        }
        case "session.execution.succeeded":
          if (sid) void finishRound(sid, "completed")
          break
        case "session.execution.failed":
          if (sid) void finishRound(sid, "failed")
          break
        case "session.execution.interrupted":
          if (sid) void finishRound(sid, "canceled")
          break
        case "session.idle":
          // 兜底：个别情况没有 execution.* 时也能收尾
          if (sid) void finishRound(sid, "completed")
          break
        default:
          break
      }
    }

    // ---------------- 启动日志（心跳不在这里，见文件头注释） ----------------
    log(`v2 start: directory=${directory} workspaceId=${readWorkspaceId(directory) || "(none)"}`)

    // ---------------- 事件订阅 ----------------
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const evt of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            handleEvent(evt as unknown as V2Evt)
          } catch (e) {
            log(`v2 event handler error: ${e}`)
          }
        }
      } catch (e) {
        if (!stopped) log(`v2 event subscribe ended: ${e}`)
      }
    })()

    // ---------------- nexus A2A WS ----------------
    async function replyPermission(requestId: string, reply: "once" | "always" | "reject") {
      const sid = inputSession.get(requestId) || currentSessionId
      if (!sid) {
        log(`permission reply failed: no session for request ${requestId.slice(0, 12)}`)
        return
      }
      await ctx.permission.reply({ sessionID: sid, requestID: requestId, decision: reply })
    }

    function connectNexus() {
      if (nexus || stopped) return
      nexus = startNexusA2AClient({
      url: config.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/plugin",
      apiKey: config.apiKey,
      workspaceId: () => readWorkspaceId(directory),
      sessionId: () => currentSessionId,
      executionMode: () => (loadConfig() ?? config).executionMode,
      onTask: executeTask,
      onReply: async (task, data) => {
        if (data.type === "permission") {
          await replyPermission(data.requestId, (data.reply ?? "once") as "once" | "always" | "reject")
        } else if (data.type === "question") {
          log(`question reply ignored: V2 server plugin has no session.form (requestId=${data.requestId.slice(0, 12)})`)
        } else {
          throw new Error(`unknown reply type: ${data.type}`)
        }
        a2aEmit(statusUpdate(task, "working", { metadata: { replied: data.requestId } }))
      },
      onPermissionReply: async (requestId, reply, replyTaskId) => {
        await replyPermission(requestId, reply)
        if (replyTaskId) monitorEmit({ roundKey: replyTaskId, type: "replied", requestId })
      },
      onQuestionReply: async (requestId, _answers, replyTaskId) => {
        log(`question reply ignored: V2 server plugin has no session.form (requestId=${requestId.slice(0, 12)})`)
        if (replyTaskId) monitorEmit({ roundKey: replyTaskId, type: "replied", requestId })
      },
      onTaskCancel: (taskId) => {
        const run = a2aRuns.get(taskId)
        const task: A2aTaskRef = { taskId, contextId: taskId }
        if (run) {
          a2aRuns.delete(taskId)
          void ctx.session.interrupt({ sessionID: run.sessionId }).catch(() => {})
        }
        a2aEmit(statusUpdate(task, "canceled", { final: true, message: agentMessage("canceled by caller", task), metadata: { session_id: run?.sessionId ?? "" } }))
      },
      log,
    })
    }
    connectNexus()

    return () => {
      stopped = true
      controller.abort()
      nexus?.close()
      // 不主动 workspace_offline：在线由 CLI 插件的心跳维持，同项目可能多开 TUI，
      // 主动下线会把还开着的那台一起打下去（让它 90s 心跳超时自然过期更稳）
      log("v2 disposed")
    }
  },
}

export default plugin
