/** agent_swarm opencode 插件：心跳保活 + A2A 任务执行。
 *
 * 面向 agent 的操作（添加/移除/启用/禁用工作区、发起 a2a_call 等）全部走服务端
 * MCP 工具（opencode.jsonc 里的 mcp.agent-swarm 配置），插件不注入任何工具。
 *
 * 任务链路（A2A 协议，nexus WS 直连）：服务端把 message/send 转成 JSON-RPC request
 * 经 WS 推给插件（离线任务在重连时补推）→ 前台注入优先（event hook 跟踪的当前会话；
 * 冷启动用 session.list 挑最近活跃会话 + tui.showToast 通知）→
 * 执行过程流式上报 A2A 事件（working/reasoning/text/tool/input-required）→
 * session.idle 提取最后 assistant 文本 → completed + Artifact 回传。
 *
 * 工作区 ID 从项目根目录 .agent_swarm/workspace.md 的 WORKSPACE_ID: 行读取
 * （workspace_add 后由 agent 写入）；日志写 plugin.log，不进控制台。
 */

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readWorkspaceId } from "./wsfile"
import { readSessionMap, writeSessionEntry } from "./sessions"
import { SwarmClient } from "./client"
import { loadConfig } from "./config"
import {
  runBackgroundTask,
  cancelBackgroundTask,
} from "./background"
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
} from "./nexus_a2a"

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

const plugin: Plugin = async (input) => {
  const { client, directory } = input
  const cfg = loadConfig()
  if (!cfg) {
    log("no apiKey config; plugin disabled")
    return {}
  }
  const config = cfg // 闭包内使用（TS 收窄在嵌套函数里失效，固定非空引用）
  const heartbeatMs = cfg.heartbeatIntervalMs ?? 30_000
  const swarm = new SwarmClient(cfg)
  const AGENT_TYPE = "opencode" // 本插件跑在 opencode 里，心跳固定上报

  let currentSessionId = ""
  let currentSessionTitle = "" // 心跳上报用（web 展示）
  let currentSessionAt = 0 // event hook 最后一次见到该会话的时间
  let disposed = false
  const idleSessions = new Set<string>() // 收到 session.idle 的会话

  /** 拉会话标题（失败返回空串，不阻塞心跳） */
  async function fetchSessionTitle(sessionId: string): Promise<string> {
    if (!sessionId) return ""
    try {
      const rsp: any = await client.session.get({ path: { id: sessionId } })
      const s = rsp?.data ?? rsp
      return String(s?.title ?? "").slice(0, 200)
    } catch {
      return ""
    }
  }

  // ---------------- nexus A2A（中枢/互调统一链路）状态 ----------------
  let nexus: NexusA2AClient | null = null
  /** 进行中的 A2A 任务：taskId → session */
  const a2aRuns = new Map<string, string>()
  /** A2A 事件上报（走当前 WS 连接） */
  function a2aEmit(event: Record<string, unknown>) {
    nexus?.send({ type: "event", payload: event })
  }
  /** SSE 事件回调注册表：taskId → handler（event hook 里分发） */
  const a2aEventHandlers = new Map<string, (evt: any) => void>()

  /** event hook 没跟踪到会话时，从 session.list 挑最近活跃的作为前台候选。
   *  排除 A2A-* 标题的后台任务会话（后台模式专用，前台注入绝不能落进去）。 */
  async function pickRecentSession(): Promise<string> {
    try {
      const rsp: any = await client.session.list()
      const list: any[] = Array.isArray(rsp?.data) ? rsp.data : []
      const best = list
        .filter((s) => s?.id && !s?.parentID && !/^A2A-/.test(String(s?.title ?? "")))
        .sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))[0]
      return best?.id ?? ""
    } catch {
      return ""
    }
  }

  // ---------------- A2A 任务执行（前台注入优先 + 流式事件上报） ----------------

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

  /** 从会话消息里提取最后一条 assistant 文本（结果 Artifact 用） */
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

  /** 从 part 提取工具事件字段（参考 opencode-feishu event.ts 的归一化） */
  function toolEventFromPart(p: Record<string, any>): {
    callId: string
    name: string
    state: "running" | "completed" | "error"
    input?: Record<string, unknown>
    output?: string
  } | null {
    const stateObj = p.state ?? {}
    const rawStatus = stateObj.status ?? (p.error != null ? "error" : "running")
    if (rawStatus === "pending") return null // 首次 pending 无时间戳，跳过
    const state: "running" | "completed" | "error" =
      rawStatus === "completed" || rawStatus === "error" ? rawStatus : "running"
    return {
      callId: String(p.callID ?? ""),
      name: String(p.tool ?? "unknown"),
      state,
      input: stateObj.input,
      output: stateObj.output,
    }
  }

  /**
   * 执行 A2A 任务（message/send）：所有进展走流式事件上报（web 中枢实时可见），
   * 完成时发 completed + Artifact。
   * 按配置分流：foreground=注入当前 TUI 前台会话；background=spawn headless 进程。
   */
  async function executeTask(task: A2aTaskRef, text: string, caller: string, serverSessionId = ""): Promise<string | null> {
    // 每次收任务重读配置：/swarm-mode 切换执行模式无需重启 opencode
    const liveCfg = loadConfig() ?? config
    if (liveCfg.executionMode === "background") {
      // 后台模式：headless 进程执行（不碰前台会话状态；--pure 不加载插件；--auto 全自动批准）。
      // 会话按来源映射表（.agent-swarm-sessions.json）路由：同一 caller 的任务复用同一
      // 后台会话（对话连续性）；不携带服务端会话锚点（那是前台 TUI 会话，resume 它等于
      // 把任务注回前台）。任务结束后把实际 sessionId 回写映射表（成功失败都写）。
      const resume = readSessionMap(directory)[caller] ?? ""
      log(`a2a ${task.taskId.slice(0, 8)}: background mode${resume ? ` (resume ${resume.slice(0, 12)})` : " (new session)"} caller=${caller}`)
      const result = await runBackgroundTask(
        task,
        text,
        caller,
        {
          cwd: directory,
          opencodeBin: liveCfg.backgroundCommand === "auto" ? "opencode" : liveCfg.backgroundCommand,
          resumeSessionId: resume,
        },
        { emit: a2aEmit, log },
      )
      if (result.sessionId) writeSessionEntry(directory, caller, result.sessionId)
      return result.ok ? (result.sessionId ?? "background") : null
    }
    return executeTaskForeground(task, text, caller, serverSessionId)
  }

  /**
   * 前台注入执行（原 executeTask 主体）。
   * 会话锚点以服务端派发的 metadata.session_id（= heartbeat 上报的工作区当前会话）为准：
   * 服务端视角的"前台会话"才是用户盯着的那个；本地 event hook 跟踪值仅作兜底
   * （heartbeat 可能还没把新会话报上去）。冷启动兜底 pickRecentSession 最后用，
   * 避免 TUI 刚起、服务端锚点还空时落到后台任务会话上。
   */
  async function executeTaskForeground(task: A2aTaskRef, text: string, caller: string, serverSessionId = ""): Promise<string | null> {
    let sessionId = serverSessionId || currentSessionId || (await pickRecentSession())
    if (!sessionId) {
      const created: any = await client.session.create({
        body: { title: `A2A-${task.taskId.slice(0, 8)}` },
      })
      sessionId = created?.data?.id ?? created?.id ?? ""
    }
    if (!sessionId) return null
    a2aRuns.set(task.taskId, sessionId)
    log(`a2a ${task.taskId.slice(0, 8)}: session ${sessionId}`)

    // working 状态 + 用户消息回显
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

    // baseline：只投影本轮 prompt 之后的消息事件
    const before: any = await client.session.messages({ path: { id: sessionId } }).catch(() => null)
    // baseline 之后出现的 messageID 才属于本轮（过滤历史 part 事件）
    const knownMessageIds = new Set<string>(
      Array.isArray(before?.data)
        ? before.data.map((m: any) => m?.info?.id ?? m?.id).filter(Boolean)
        : [],
    )

    // 权限/提问状态（避免重复发 input-required）
    let inputState: "permission" | "question" | null = null

    // 监听本次任务产生的 SSE 事件 → A2A 流式事件（由全局 event hook 回调分发）
    a2aEventHandlers.set(task.taskId, (evt: any) => {
      const type = evt?.type as string
      const props = evt?.properties ?? {}
      if (props.sessionID !== sessionId) return

      if (type === "message.part.updated") {
        const part = props.part ?? {}
        const msgId = String(part.messageID ?? "")
        if (msgId && knownMessageIds.has(msgId)) return // 历史消息的快照，跳过
        const partId = String(part.id ?? "")
        if (part.type === "tool") {
          const ev = toolEventFromPart(part)
          if (ev) a2aEmit(toolStatus(task, ev))
        } else if (part.type === "reasoning") {
          if (part.text?.trim()) a2aEmit(streamStatus(task, "reasoning", partId, part.text))
        } else if (part.type === "text" && !part.synthetic) {
          if (part.text?.trim()) a2aEmit(streamStatus(task, "text", partId, part.text))
        }
      } else if (type === "permission.asked") {
        // 权限请求 → input-required（卡在 TUI 的授权菜单 web 端看不到）
        const request = props as Record<string, any>
        const permissionId = String(request.id ?? "")
        if (permissionId && inputState !== "permission") {
          inputState = "permission"
          a2aEmit(
            inputRequired(task, "permission", {
              requestId: permissionId,
              sessionId,
              permission: String(request.permission ?? request.type ?? "unknown"),
              title: String(request.title ?? request.pattern ?? ""),
            }),
          )
        }
      } else if (type === "question.asked") {
        // AI 提问 → input-required
        const request = props as Record<string, any>
        const questionId = String(request.id ?? "")
        const q = Array.isArray(request.questions) ? request.questions[0] : undefined
        if (questionId && q && inputState !== "question") {
          inputState = "question"
          a2aEmit(
            inputRequired(task, "question", {
              requestId: questionId,
              sessionId,
              question: String(q.question ?? q.header ?? "请选择"),
              options: (Array.isArray(q.options) ? q.options : []).map((o: any, i: number) => ({
                label: String(o.label ?? o.value ?? `选项 ${i + 1}`),
                value: String(o.value ?? o.label ?? ""),
              })),
            }),
          )
        }
      } else if (type === "session.error") {
        const err = props.error
        const msgText =
          typeof err === "string" ? err : err?.message ?? err?.type ?? "unknown error"
        a2aEmit(
          statusUpdate(task, "failed", {
            final: true,
            message: agentMessage(String(msgText), task),
            metadata: { error: String(msgText) },
          }),
        )
      }
    })

    try {
      // prompt 开头标注来源，agent 与用户都知道任务来自哪个渠道
      await client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: buildTaskPrompt(text, caller, task.taskId) }] },
      })
    } catch (e) {
      a2aEmit(
        statusUpdate(task, "failed", {
          final: true,
          message: agentMessage(String(e), task),
        }),
      )
      cleanupRun(task.taskId)
      throw e
    }
    // 完成判定由 event hook 的 session.idle 处理（见下方 event 回调）
    return sessionId
  }

  function cleanupRun(taskId: string) {
    a2aEventHandlers.delete(taskId)
    a2aRuns.delete(taskId)
  }

  // ---------------- opencode 权限/提问 API（web 应答 & A2A 续聊共用） ----------------

  async function onPermissionReplyImpl(_taskId: string, requestId: string, reply: "once" | "always" | "reject") {
    // 响应 opencode 权限请求（web 中枢的允许/拒绝按钮）
    await client.postSessionIdPermissionsPermissionId({
      path: { id: currentSessionId, permissionID: requestId },
      body: { response: reply },
    })
  }

  async function onQuestionReplyImpl(_taskId: string, requestId: string, answers: string[][]) {
    // 响应 AI 提问：v1 SDK 无 question API，走通用 post（feishu 项目同款兜底）
    const inner = (client as any)?._client
    if (!inner?.post) throw new Error("no inner http client")
    await inner.post({
      url: "/question/{requestID}/reply",
      path: { requestID: requestId },
      body: { answers },
      query: directory ? { directory } : undefined,
    })
  }

  // ---------------- 心跳 + 领取 ----------------

  async function heartbeatLoop() {
    let workspaceId = readWorkspaceId(directory)
    let lastTitleSession = "" // 上次拉过标题的会话，避免重复查询
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
          // 会话变化时刷新一次标题（避免每轮心跳都查 session.get）
          if (currentSessionId && currentSessionId !== lastTitleSession) {
            currentSessionTitle = await fetchSessionTitle(currentSessionId)
            lastTitleSession = currentSessionId
          }
          const rsp = await swarm.heartbeat(
            workspaceId,
            currentSessionId || undefined,
            AGENT_TYPE,
            currentSessionTitle || undefined,
          )
        } catch (e) {
          log(`heartbeat failed: ${e}`)
        }
      }
      await new Promise((r) => setTimeout(r, heartbeatMs))
    }
  }

  heartbeatLoop()

  // ---------------- nexus A2A WS 直连（中枢下发 + 工作区互调统一入口） ----------------
  nexus = startNexusA2AClient({
    url: cfg.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/plugin",
    apiKey: cfg.apiKey,
    workspaceId: () => readWorkspaceId(directory),
    onTask: executeTask,
    onReply: async (task, data) => {
      // input-required 续聊应答：路由到 opencode 权限/提问 API
      if (data.type === "permission") {
        const reply = (data.reply ?? "once") as "once" | "always" | "reject"
        await onPermissionReplyImpl(task.taskId, data.requestId, reply)
      } else if (data.type === "question") {
        await onQuestionReplyImpl(task.taskId, data.requestId, data.answers ?? [])
      } else {
        throw new Error(`unknown reply type: ${data.type}`)
      }
      // 应答后任务回到 working（服务端收到插件的 rpc 应答无需额外事件；
      // 插件本地补一个 working 事件让 web 端结束等待态）
      a2aEmit(statusUpdate(task, "working", { metadata: { replied: data.requestId } }))
    },
    onPermissionReply: async (requestId, reply) => {
      await onPermissionReplyImpl("", requestId, reply)
    },
    onQuestionReply: async (requestId, answers) => {
      await onQuestionReplyImpl("", requestId, answers)
    },
    onTaskCancel: (taskId) => {
      // 取消：后台任务 kill 进程树；前台任务标记 canceled（已注入的 opencode 会话无法中断）
      if (cancelBackgroundTask(taskId)) {
        log(`a2a ${taskId.slice(0, 8)}: background process killed`)
        return // 进程 close 回调会上报 canceled/failed 终态
      }
      const sessionId = a2aRuns.get(taskId)
      const task: A2aTaskRef = { taskId, contextId: taskId }
      a2aEmit(
        statusUpdate(task, "canceled", {
          final: true,
          message: agentMessage("canceled by caller", task),
          metadata: { session_id: sessionId ?? "" },
        }),
      )
      cleanupRun(taskId)
    },
    log,
  })

  return {
    // 跟踪当前会话 id（心跳上报用）+ A2A 流式事件分发 + idle 完成判定
    event: async ({ event }) => {
      const anyEvt = event as any
      const sid = anyEvt?.properties?.sessionID ?? anyEvt?.info?.sessionID
      if (typeof sid === "string" && sid) {
        currentSessionId = sid
        currentSessionAt = Date.now()
      }
      // A2A 流式事件分发
      if (a2aEventHandlers.size && anyEvt?.type !== "session.idle") {
        for (const handler of a2aEventHandlers.values()) {
          try { handler(anyEvt) } catch { /* 单个 handler 失败不影响其他 */ }
        }
      }
      // session.idle：该会话本轮 prompt 处理完毕 → 提取结果发 completed + Artifact
      if (anyEvt?.type === "session.idle" && typeof sid === "string" && sid) {
        idleSessions.add(sid)
        for (const [taskId, runSid] of a2aRuns) {
          if (runSid !== sid) continue
          const task: A2aTaskRef = { taskId, contextId: taskId }
          try {
            // idle 后再等一拍，避免消息尚未落盘
            await new Promise((r) => setTimeout(r, 1_000))
            const rsp: any = await client.session.messages({ path: { id: sid } }).catch(() => null)
            const msgs: any[] = Array.isArray(rsp?.data) ? rsp.data : []
            const lastText = extractLastAssistantText(msgs)
            if (lastText) {
              const artifactId = `artifact-${taskId}`
              a2aEmit(artifactUpdate(task, lastText, true, artifactId))
              a2aEmit(statusUpdate(task, "completed", { final: true, metadata: { session_id: sid } }))
              log(`a2a ${taskId.slice(0, 8)}: completed (${lastText.length} chars)`)
            } else {
              a2aEmit(
                statusUpdate(task, "failed", {
                  final: true,
                  message: agentMessage("执行超时或未产生结果", task),
                  metadata: { session_id: sid },
                }),
              )
              log(`a2a ${taskId.slice(0, 8)}: failed (no result text)`)
            }
          } catch (e) {
            a2aEmit(
              statusUpdate(task, "failed", {
                final: true,
                message: agentMessage(`插件执行失败: ${e}`, task),
              }),
            )
            log(`a2a ${taskId.slice(0, 8)}: execute failed: ${e}`)
          }
          cleanupRun(taskId)
        }
      }
    },

    dispose: async () => {
      disposed = true
      nexus?.close()
      // 主动下线：不等 90s 心跳超时（失败无所谓，超时兜底）
      const wid = readWorkspaceId(directory)
      if (wid) {
        await swarm
          .callTool("workspace_offline", { workspace_id: wid })
          .then(() => log(`offline notification sent for ${wid}`))
          .catch((e) => log(`offline notify failed (timeout fallback): ${e}`))
      }
      log("disposed")
    },
  }
}

export default plugin
