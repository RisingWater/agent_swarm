/** agent_swarm opencode 插件：心跳保活 + workspace_call 任务执行。
 *
 * 面向 agent 的操作（添加/移除/启用/禁用工作区、发起调用等）全部走服务端
 * MCP 工具（opencode.jsonc 里的 mcp.agent-swarm 配置），插件不注入任何工具。
 *
 * 任务链路：heartbeat 响应捎带 pending 调用任务 → 插件领取（ack）→
 * 前台注入优先：优先 prompt 进当前 TUI 正在看的会话（event hook 跟踪的会话；
 * 尚无事件时用 session.list 挑最近活跃的会话，并用 tui.showToast 弹通知）；
 * 前台已有任务或目标会话 busy 时排队等待；完全无会话或等待超时才退回
 * client.session.create 后台会话（会话列表可见可围观）→
 * 监听 session.idle + 轮询 messages 判定完成 →
 * 提取最后 assistant 文本回传（workspace_call_result）。
 *
 * 工作区 ID 从项目根目录 .agent-swarm.md 的 WORKSPACE_ID: 行读取
 * （workspace_add 后由 agent 写入）；日志写 plugin.log，不进控制台。
 */

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readWorkspaceId } from "./wsfile"
import { SwarmClient, type SwarmCall } from "./client"
import { loadConfig } from "./config"
import { startNexusClient, type NexusClient, type TimelineEvent } from "./nexus"

const LOG_FILE = join(homedir(), ".config", "opencode", "plugins", "agent-swarm", "plugin.log")
const LOG_MAX_BYTES = 1_000_000

function log(msg: string) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      // 截断保留后半段，避免无限增长
      const text = readFileSync(LOG_FILE, "utf-8")
      truncateSync(LOG_FILE, 0)
      appendFileSync(LOG_FILE, text.slice(text.length - LOG_MAX_BYTES / 2))
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // 日志失败不影响主流程
  }
}

const MAX_CONCURRENT_CALLS = 2
const IDLE_POLL_MS = 2_000
const IDLE_TIMEOUT_MS = 30 * 60_000
const NUDGE_MAX = 2
/** 前台被占用时排队等待的上限，超时退回后台会话 */
const FG_WAIT_TIMEOUT_MS = 10 * 60_000

const plugin: Plugin = async (input) => {
  const { client, directory } = input
  const cfg = loadConfig()
  if (!cfg) {
    log("no apiKey config; plugin disabled")
    return {}
  }
  const heartbeatMs = cfg.heartbeatIntervalMs ?? 30_000
  const swarm = new SwarmClient(cfg)
  const AGENT_TYPE = "opencode" // 本插件跑在 opencode 里，心跳固定上报

  let currentSessionId = ""
  let currentSessionAt = 0 // event hook 最后一次见到该会话的时间
  let disposed = false
  const executing = new Set<string>() // 正在执行的 call_id
  const idleSessions = new Set<string>() // 收到 session.idle 的会话
  let fgBusy = false // 前台会话是否有 swarm 任务在跑

  // ---------------- nexus（中枢直连）状态 ----------------
  let nexus: NexusClient | null = null
  /** 当前 nexus 指令的 run 上下文：req_id → session */
  const nexusRuns = new Map<string, string>()
  /** nexus 指令 baseline 消息数：req_id → 执行前的消息长度 */
  const nexusBaselines = new Map<string, number>()
  let nexusSeq = 0

  function nexusEmit(event: TimelineEvent) {
    nexusSend({ type: "event", event })
  }

  function nexusSend(obj: Record<string, unknown>): boolean {
    // nexusSend 由 NexusClient 内部的 send 承载，这里透传给当前连接
    return nexusRawSend(obj)
  }
  let nexusRawSend: (obj: Record<string, unknown>) => boolean = () => false

  /** 目标会话是否正在跑模型（busy/retry），running 状态的会话不该被注入 */
  async function isSessionBusy(sessionId: string): Promise<boolean> {
    try {
      const rsp: any = await client.session.status()
      const map = rsp?.data ?? rsp ?? {}
      const st = map[sessionId]
      return !!st && st.type !== "idle"
    } catch {
      return false // 查不到就当空闲，注入后靠排队机制兜底
    }
  }

  /** event hook 没跟踪到会话时，从 session.list 挑最近活跃的作为前台候选 */
  async function pickRecentSession(): Promise<string> {
    try {
      const rsp: any = await client.session.list()
      const list: any[] = Array.isArray(rsp?.data) ? rsp.data : []
      const best = list
        .filter((s) => s?.id && !s?.parentID)
        .sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))[0]
      return best?.id ?? ""
    } catch {
      return ""
    }
  }

  /** 等前台空闲；返回 true 拿到前台，false 等待超时 */
  async function waitForForeground(callId: string): Promise<boolean> {
    const deadline = Date.now() + FG_WAIT_TIMEOUT_MS
    while (!disposed && Date.now() < deadline) {
      if (!fgBusy) return true
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS))
    }
    log(`call ${callId}: foreground wait timeout, fallback to background`)
    return false
  }

  // ---------------- 任务执行（前台注入优先 + idle 判定） ----------------

  function buildTaskPrompt(call: SwarmCall): string {
    const caller = call.caller
    return [
      `[agent_swarm 调用任务 call_id=${call.call_id}]`,
      caller ? `来自工作区「${caller.name}」（${caller.path}）` : "来自其他工作区",
      "",
      "任务指令：",
      call.instruction,
      "",
      "处理要求：",
      "1. 在当前工作区中完成上述任务（查看代码/修改代码/回答问题）。",
      "2. 完成后用一段话总结结果（做了什么/结论/改动点），系统会自动把总结回传给调用方，不要调用任何工具回传。",
      "3. 无法完成时，直接说明原因即可。",
    ].join("\n")
  }

  /** 从会话消息里提取最后一条 assistant 文本（结果回传用） */
  function extractLastAssistantText(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      const info = m?.info ?? m
      if (info?.role !== "assistant") continue
      const parts = m?.parts ?? []
      const texts = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
        .map((p: any) => p.text.trim())
      if (texts.length) return texts.join("\n")
    }
    return ""
  }

  /** 判断最后一条 assistant 消息是否停在工具调用上（需要 nudge） */
  function endsWithToolCall(messages: any[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      const info = m?.info ?? m
      if (info?.role !== "assistant") continue
      const parts = m?.parts ?? []
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]
        if (p?.type === "tool") return true
        if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) return false
      }
      return false
    }
    return false
  }

  async function executeCall(call: SwarmCall) {
    if (executing.size >= MAX_CONCURRENT_CALLS) {
      log(`call ${call.call_id} deferred (${executing.size} executing)`)
      return false // 满载：下轮心跳重新领取（任务还在 pending）
    }
    executing.add(call.call_id)
    void (async () => {
      let fgHeld = false
      try {
        // 前台注入优先：prompt 进 TUI 正在看的会话，用户实时可见。
        // 会话来源：event hook 跟踪的会话；冷启动没事件时用 session.list 挑最近活跃的。
        // 前台被占用/会话 busy 则排队等待；无会话或等待超时才退回后台会话
        let sessionId = ""
        let candidate = currentSessionId || (await pickRecentSession())
        if (candidate) {
          const got = await waitForForeground(call.call_id)
          // 等待期间逐拍检查会话是否 busy（用户正在跑别的任务时继续等）
          const deadline = Date.now() + FG_WAIT_TIMEOUT_MS
          while (got && !disposed && (await isSessionBusy(candidate))) {
            if (Date.now() > deadline) break
            log(`call ${call.call_id}: session ${candidate} busy, waiting`)
            await new Promise((r) => setTimeout(r, IDLE_POLL_MS))
          }
          if (got && !disposed && !(await isSessionBusy(candidate))) {
            sessionId = candidate
          }
        }
        if (sessionId) {
          fgBusy = true
          fgHeld = true
          log(`call ${call.call_id}: foreground inject into ${sessionId}`)
          // TUI 可见通知：任务已注入前台会话
          await client.tui
            .showToast({
              body: {
                title: "agent_swarm",
                message: `收到 swarm 调用任务 ${call.call_id.slice(0, 8)}，已在当前会话执行`,
                variant: "info",
                duration: 8000,
              },
            })
            .catch(() => {})
        } else {
          if (!currentSessionId) log(`call ${call.call_id}: no foreground session, use background`)
          const created: any = await client.session.create({
            body: { title: `Swarm-call-${call.call_id.slice(0, 8)}` },
          })
          sessionId = created?.data?.id ?? created?.id ?? ""
          log(`call ${call.call_id}: background session ${sessionId}`)
        }
        if (!sessionId) throw new Error("session create failed")

        const ack = await swarm.ackCall(call.call_id, sessionId).catch((e) => {
          log(`call ${call.call_id}: ack failed: ${e}`)
          return null
        })
        if (ack && (ack as any).status !== "running") {
          log(`call ${call.call_id}: ack returned ${(ack as any).status}, skip`)
          return
        }

        // baseline：只关注本轮 prompt 之后的消息（并清掉旧 idle 残留，
        // 防止之前任务留下的 idle 让本轮瞬间误判完成）
        idleSessions.delete(sessionId)
        const before = await client.session.messages({ path: { id: sessionId } }).catch(() => null)
        const baselineLen = Array.isArray((before as any)?.data) ? (before as any).data.length : 0

        await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: buildTaskPrompt(call) }] },
        })
        // idle 判定：SSE event hook 置 idleSessions；这里轮询兜底
        const deadline = Date.now() + IDLE_TIMEOUT_MS
        let nudges = 0
        let lastText = ""
        while (!disposed && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, IDLE_POLL_MS))
          if (idleSessions.has(sessionId)) {
            // idle 后再等一拍，避免消息尚未落盘
            await new Promise((r) => setTimeout(r, 1_000))
            const rsp: any = await client.session.messages({ path: { id: sessionId } }).catch(() => null)
            const msgs: any[] = Array.isArray(rsp?.data) ? rsp.data : []
            const recent = msgs.slice(baselineLen)
            lastText = extractLastAssistantText(recent)
            if (endsWithToolCall(recent) && nudges < NUDGE_MAX) {
              nudges++
              log(`call ${call.call_id}: idle on tool call, nudge #${nudges}`)
              idleSessions.delete(sessionId)
              await client.session.promptAsync({
                path: { id: sessionId },
                body: { parts: [{ type: "text", text: "继续完成上述任务并给出最终总结。", synthetic: true }] },
              }).catch(() => {})
              continue
            }
            break
          }
        }

        if (lastText) {
          await swarm.submitCallResult(call.call_id, true, lastText)
          log(`call ${call.call_id}: done (${lastText.length} chars)`)
        } else {
          await swarm.submitCallResult(call.call_id, false, "执行超时或未产生结果")
          log(`call ${call.call_id}: failed (no result text)`)
        }
      } catch (e) {
        log(`call ${call.call_id}: execute failed: ${e}`)
        await swarm.submitCallResult(call.call_id, false, `插件执行失败: ${e}`).catch(() => {})
      } finally {
        if (fgHeld) fgBusy = false
        executing.delete(call.call_id)
      }
    })()
    return true
  }

  // ---------------- nexus 指令执行（web 中枢下发，timeline 上报） ----------------

  /** 从 part 提取工具卡所需字段（参考 opencode-feishu event.ts 的归一化） */
  function toolEventFromPart(reqId: string, p: Record<string, any>): TimelineEvent | null {
    const stateObj = p.state ?? {}
    const rawStatus = stateObj.status ?? (p.error != null ? "error" : "running")
    if (rawStatus === "pending") return null // 首次 pending 无时间戳，跳过
    const state: "running" | "completed" | "error" =
      rawStatus === "completed" || rawStatus === "error" ? rawStatus : "running"
    return {
      kind: "tool-state-changed",
      req_id: reqId,
      call_id: String(p.callID ?? ""),
      tool: String(p.tool ?? "unknown"),
      state,
      input: stateObj.input,
      output: stateObj.output,
      time: stateObj.time?.start ?? Date.now(),
    }
  }

  /**
   * 执行 nexus 下发的 prompt。
   * 与 executeCall 不同：不开后台会话、不占 fgBusy 锁（web 端看到的就是实时时间线），
   * 优先注入当前前台会话（与 swarm call 一致），SSE 事件实时上报 timeline。
   */
  async function executeNexusCommand(reqId: string, text: string, source = "nexus-web"): Promise<string | null> {
    let sessionId = currentSessionId || (await pickRecentSession())
    if (!sessionId) {
      const created: any = await client.session.create({
        body: { title: `Nexus-${reqId.slice(0, 8)}` },
      })
      sessionId = created?.data?.id ?? created?.id ?? ""
    }
    if (!sessionId) throw new Error("no session available")
    nexusRuns.set(reqId, sessionId)
    log(`nexus ${reqId.slice(0, 8)}: session ${sessionId}`)

    nexusEmit({ kind: "run-started", req_id: reqId, session_id: sessionId, text, time: Date.now() })

    // baseline：只投影本轮 prompt 之后的消息事件
    const before: any = await client.session.messages({ path: { id: sessionId } }).catch(() => null)
    nexusBaselines.set(reqId, Array.isArray(before?.data) ? before.data.length : 0)

    // baseline 之后出现的 messageID 才属于本轮（过滤历史 part 事件）
    const knownMessageIds = new Set<string>(
      Array.isArray(before?.data)
        ? before.data.map((m: any) => m?.info?.id ?? m?.id).filter(Boolean)
        : [],
    )

    // 监听本次指令产生的 SSE 事件 → timeline（由全局 event hook 回调写入队列）
    nexusEventHandlers.set(reqId, (evt: any) => {
      const type = evt?.type as string
      const props = evt?.properties ?? {}
      if (props.sessionID !== sessionId) return

      if (type === "message.part.updated") {
        const part = props.part ?? {}
        const msgId = String(part.messageID ?? "")
        if (msgId && knownMessageIds.has(msgId)) return // 历史消息的快照，跳过
        const partId = String(part.id ?? "")
        if (part.type === "tool") {
          const ev = toolEventFromPart(reqId, part)
          if (ev) nexusEmit(ev)
        } else if (part.type === "reasoning") {
          if (part.text?.trim()) {
            nexusEmit({ kind: "reasoning-updated", req_id: reqId, part_id: partId, text: part.text, time: part.time?.start ?? Date.now() })
          }
        } else if (part.type === "text" && !part.synthetic) {
          if (part.text?.trim()) {
            nexusEmit({ kind: "text-updated", req_id: reqId, part_id: partId, text: part.text, time: part.time?.start ?? Date.now() })
          }
        }
      } else if (type === "permission.asked") {
        // 权限请求：上报给 web，由用户在中枢点允许/拒绝（卡在 TUI 的授权菜单 web 端看不到）
        const request = props as Record<string, any>
        const permissionId = String(request.id ?? "")
        if (permissionId) {
          nexusEmit({
            kind: "permission-requested",
            req_id: reqId,
            request_id: permissionId,
            session_id: sessionId,
            permission: String(request.permission ?? request.type ?? "unknown"),
            title: String(request.title ?? request.pattern ?? ""),
            time: Date.now(),
          })
        }
      } else if (type === "question.asked") {
        // AI 提问（选方案/确认等）：上报选项给 web，由用户在中枢点选
        const request = props as Record<string, any>
        const questionId = String(request.id ?? "")
        const q = Array.isArray(request.questions) ? request.questions[0] : undefined
        if (questionId && q) {
          nexusEmit({
            kind: "question-requested",
            req_id: reqId,
            request_id: questionId,
            session_id: sessionId,
            question: String(q.question ?? q.header ?? "请选择"),
            options: (Array.isArray(q.options) ? q.options : []).map((o: any, i: number) => ({
              label: String(o.label ?? o.value ?? `选项 ${i + 1}`),
              value: String(o.value ?? o.label ?? ""),
            })),
            time: Date.now(),
          })
        }
      } else if (type === "session.error") {
        const err = props.error
        const msgText =
          typeof err === "string" ? err : err?.message ?? err?.type ?? "unknown error"
        nexusEmit({ kind: "run-error", req_id: reqId, error: String(msgText), time: Date.now() })
      }
    })

    try {
      // prompt 开头标注来源（nexus-web / nexus-feishu / ...），agent 与用户都知道指令来自哪个渠道
      await client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: `[来自 ${source} 的指令]\n\n${text}` }] },
      })
    } catch (e) {
      nexusEmit({ kind: "run-error", req_id: reqId, error: String(e), time: Date.now() })
      cleanupNexusRun(reqId)
      throw e
    }
    // 完成判定由 event hook 的 session.idle 处理（见下方 event 回调）
    return sessionId
  }

  function cleanupNexusRun(reqId: string) {
    nexusEventHandlers.delete(reqId)
    nexusRuns.delete(reqId)
    nexusBaselines.delete(reqId)
  }

  /** req_id → SSE 事件回调（event hook 里分发） */
  const nexusEventHandlers = new Map<string, (evt: any) => void>()

  // ---------------- 心跳 + 领取 ----------------

  async function heartbeatLoop() {
    let workspaceId = readWorkspaceId(directory)
    log(`start: directory=${directory} workspaceId=${workspaceId || "(none)"} interval=${heartbeatMs}ms`)
    while (!disposed) {
      // 每轮重读文件：agent 重新 add/换 ID 后无需重启
      const id = readWorkspaceId(directory)
      if (id !== workspaceId) {
        workspaceId = id
        log(`workspace id ${id ? `updated: ${id}` : "cleared"}`)
      }
      if (workspaceId) {
        try {
          const rsp = await swarm.heartbeat(workspaceId, currentSessionId || undefined, AGENT_TYPE)
          const calls = rsp?.calls ?? []
          if (calls.length) log(`heartbeat: ${calls.length} pending call(s)`)
          for (const call of calls) {
            if (executing.has(call.call_id)) continue
            await executeCall(call)
          }
        } catch (e) {
          log(`heartbeat failed: ${e}`)
        }
      }
      await new Promise((r) => setTimeout(r, heartbeatMs))
    }
  }

  heartbeatLoop()

  // ---------------- nexus WS 直连（web 中枢下发指令 + timeline 上报） ----------------
  nexus = startNexusClient({
    url: cfg.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/plugin",
    apiKey: cfg.apiKey,
    workspaceId: () => readWorkspaceId(directory),
    onCommand: executeNexusCommand,
    onPermissionReply: async (requestId, reply) => {
      // 响应 opencode 权限请求（web 中枢的允许/拒绝按钮）
      await client.postSessionIdPermissionsPermissionId({
        path: { id: currentSessionId, permissionID: requestId },
        body: { response: reply },
      })
    },
    onQuestionReply: async (requestId, answers) => {
      // 响应 AI 提问：v1 SDK 无 question API，走通用 post（feishu 项目同款兜底）
      const inner = (client as any)?._client
      if (!inner?.post) throw new Error("no inner http client")
      await inner.post({
        url: "/question/{requestID}/reply",
        path: { requestID: requestId },
        body: { answers },
        query: directory ? { directory } : undefined,
      })
    },
    log,
  })
  // 把 nexus 内部 send 暴露给 nexusEmit（事件上报走同一条连接）
  nexusRawSend = (obj: Record<string, unknown>) => nexus.send(obj)

  return {
    // 跟踪当前会话 id（心跳上报用）+ 记录 swarm 任务会话的 idle + nexus timeline 分发
    event: async ({ event }) => {
      const anyEvt = event as any
      const sid = anyEvt?.properties?.sessionID ?? anyEvt?.info?.sessionID
      if (typeof sid === "string" && sid) {
        currentSessionId = sid
        currentSessionAt = Date.now()
      }
      // nexus timeline 事件分发
      if (nexusEventHandlers.size && anyEvt?.type !== "session.idle") {
        for (const handler of nexusEventHandlers.values()) {
          try { handler(anyEvt) } catch { /* 单个 handler 失败不影响其他 */ }
        }
      }
      // session.idle：该会话本轮 prompt 处理完毕
      if (anyEvt?.type === "session.idle" && typeof sid === "string" && sid) {
        idleSessions.add(sid)
        // nexus 指令完成判定：该 session 有 run 在跑 → 上报 idle 并清理
        for (const [reqId, runSid] of nexusRuns) {
          if (runSid === sid) {
            nexusEmit({ kind: "session-idle", req_id: reqId, session_id: sid, time: Date.now() })
            cleanupNexusRun(reqId)
          }
        }
      }
    },

    dispose: async () => {
      disposed = true
      nexus?.close()
      log("disposed")
    },
  }
}

export default plugin
