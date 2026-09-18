/** agent_swarm nexus A2A 插件客户端（JSON-RPC/A2A over WebSocket）。
 *
 * 连接服务端 /ws/plugin，注册工作区后：
 * - 接收服务端转发的 A2A JSON-RPC request（message/send），注入 opencode 会话执行
 * - 流式事件（思考/文本/工具/权限/提问）归一化为 A2A TaskStatusUpdateEvent /
 *   TaskArtifactUpdateEvent 上报；权限/提问触发 input-required
 * - 完成时发 completed + final Artifact（最后一条 assistant 文本，markdown）
 *
 * 事件形状对齐 A2A 0.3.x 规范（camelCase + kind 判别符），服务端原样转发存储。
 * 使用 Node 22+ 内置全局 WebSocket，不引入依赖。
 */

export interface NexusA2AClient {
  close: () => void
  isReady: () => boolean
  send: (obj: Record<string, unknown>) => boolean
  /** 前台会话监控事件上报（{"type":"monitor",...}；断连入缓冲，重连补发） */
  sendMonitor: (payload: Record<string, unknown>) => void
}

export interface A2aTaskRef {
  taskId: string
  contextId: string
}

export interface A2aOptions {
  /** ws(s)://host:port/ws/plugin */
  url: string
  apiKey: string
  workspaceId: () => string
  /** 收到 message/send：注入会话执行。返回 sessionId（服务端记录 task.session_id）。
   *  serverSessionId = 服务端派发的会话锚点（heartbeat 上报的工作区当前会话），后台执行时作 --session 续聊 */
  onTask: (task: A2aTaskRef, text: string, caller: string, serverSessionId?: string) => Promise<string | null>
  /** 收到 input-required 续聊应答（权限/提问），由服务端转成 message/send DataPart */
  onReply: (task: A2aTaskRef, data: { type: string; requestId: string; reply?: string; answers?: string[][] }) => Promise<void>
  /** 权限请求答复（A2A input-required 续聊，data.type=permission）。
   *  replyTaskId = 应答归属的轮次（监控轮 roundKey / A2A 轮 taskId），供应答后补状态事件 */
  onPermissionReply: (requestId: string, reply: "once" | "always" | "reject", replyTaskId?: string) => Promise<void>
  /** 问答回答（data.type=question），answers 为 [[value], ...] */
  onQuestionReply: (requestId: string, answers: string[][], replyTaskId?: string) => Promise<void>
  /** 服务端转发的取消请求 */
  onTaskCancel?: (taskId: string) => void
  log: (msg: string) => void
}

const PING_INTERVAL_MS = 15_000
const MAX_RECONNECT_DELAY_MS = 15_000

// ---------------------------------------------------------------- A2A 事件构造

export type A2aEvent = Record<string, unknown>

export function statusUpdate(
  task: A2aTaskRef,
  state: string,
  opts: {
    final?: boolean
    message?: Record<string, unknown> | null
    metadata?: Record<string, unknown>
  } = {},
): A2aEvent {
  const status: Record<string, unknown> = { state }
  if (opts.message) status.message = opts.message
  const ev: Record<string, unknown> = {
    taskId: task.taskId,
    contextId: task.contextId,
    kind: "status-update",
    status,
    final: opts.final ?? false,
  }
  if (opts.metadata) ev.metadata = opts.metadata
  return ev
}

export function agentMessage(text: string, task: A2aTaskRef): Record<string, unknown> {
  return {
    role: "agent",
    parts: [{ kind: "text", text }],
    messageId: `msg-${task.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.taskId,
    contextId: task.contextId,
  }
}

export function artifactUpdate(
  task: A2aTaskRef,
  text: string,
  lastChunk: boolean,
  artifactId: string,
): A2aEvent {
  return {
    taskId: task.taskId,
    contextId: task.contextId,
    kind: "artifact-update",
    artifact: {
      artifactId,
      name: "result",
      parts: [{ kind: "text", text }],
    },
    lastChunk,
  }
}

/** 权限请求 → input-required 事件（DataPart 携带应答所需信息） */
export function inputRequired(
  task: A2aTaskRef,
  type: "permission" | "question",
  payload: Record<string, unknown>,
): A2aEvent {
  return statusUpdate(task, "input-required", {
    message: {
      role: "agent",
      parts: [
        {
          kind: "data",
          data: { type, taskId: task.taskId, ...payload },
        },
      ],
      messageId: `msg-${task.taskId}-input-${Date.now()}`,
      taskId: task.taskId,
      contextId: task.contextId,
    },
    metadata: { type },
  })
}

/** 工具执行状态事件（opencode part → metadata，服务端/web 直接透传渲染） */
export function toolStatus(
  task: A2aTaskRef,
  tool: { callId: string; name: string; state: string; input?: unknown; output?: string },
): A2aEvent {
  return statusUpdate(task, "working", {
    metadata: {
      nexus: "tool",
      call_id: tool.callId,
      tool: tool.name,
      tool_state: tool.state,
      input: tool.input,
      output: tool.output,
    },
  })
}

/** 思考/文本流式片段（opencode part → metadata.nexus=text/reasoning）。
 *  mode: "replace"=全量快照（前端覆盖渲染），"append"=增量 delta（前端拼接累积）。
 *  opencode part 事件是全量快照；claude stream-json delta 是增量。 */
export function streamStatus(
  task: A2aTaskRef,
  kind: "text" | "reasoning",
  partId: string,
  text: string,
  mode: "replace" | "append" = "replace",
): A2aEvent {
  return statusUpdate(task, "working", {
    metadata: { nexus: kind, part_id: partId, text, mode },
  })
}

export function parseInputRequired(event: A2aEvent): { type: string; requestId: string; data: Record<string, unknown> } | null {
  if (event.kind !== "status-update") return null
  const status = event.status as Record<string, unknown> | undefined
  if (!status || status.state !== "input-required") return null
  const msg = status.message as Record<string, unknown> | undefined
  const parts = (msg?.parts ?? []) as Array<Record<string, unknown>>
  const data = (parts.find((p) => p.kind === "data")?.data ?? {}) as Record<string, unknown>
  const type = String(data.type ?? "")
  const requestId = String(data.requestId ?? data.request_id ?? "")
  if (!type || !requestId) return null
  return { type, requestId, data }
}

// ---------------------------------------------------------------- 客户端主体

export function startNexusA2AClient(options: A2aOptions): NexusA2AClient {
  const { url, apiKey, workspaceId, onTask, onReply, onPermissionReply, onQuestionReply, onTaskCancel, log } = options

  let ws: WebSocket | null = null
  let ready = false
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let reconnectDelay = 1_000
  /** WS 断连期间的 event/monitor 缓冲（重连后补发，上限防内存失控） */
  const pendingMessages: Array<Record<string, unknown>> = []
  const MAX_PENDING_MESSAGES = 2000

  function send(obj: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  /** event/monitor 发送：断连时入缓冲，重连后 flush */
  function sendMessage(obj: Record<string, unknown>): void {
    if (send(obj)) return
    if (pendingMessages.length < MAX_PENDING_MESSAGES) pendingMessages.push(obj)
  }

  function flushPendingMessages(): void {
    while (pendingMessages.length) {
      if (!send(pendingMessages[0])) break // 又断了，剩下的下次发
      pendingMessages.shift()
    }
  }

  function startPing() {
    stopPing()
    pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS)
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
      connect()
    }, reconnectDelay)
  }

  function handle(raw: string) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case "hello_ok":
        ready = true
        reconnectDelay = 1_000
        startPing()
        flushPendingMessages()
        log("nexus a2a ready")
        break
      case "hello_err":
        log(`nexus hello rejected: ${msg.error}`)
        closed = true // 注册被拒不会自愈，停止重连
        try { ws?.close() } catch { /* ignore */ }
        break
      case "pong":
        break
      case "rpc": {
        // 服务端转发的 JSON-RPC request（message/send / tasks/cancel）
        const payload = (msg.payload ?? {}) as Record<string, unknown>
        const method = String(payload.method ?? "")
        const id = String(payload.id ?? "")
        const params = (payload.params ?? {}) as Record<string, unknown>
        if (method === "message/send") {
          const message = (params.message ?? {}) as Record<string, unknown>
          const metadata = (params.metadata ?? {}) as Record<string, unknown>
          const parts = (message.parts ?? []) as Array<Record<string, unknown>>
          const task: A2aTaskRef = {
            taskId: String(message.taskId ?? ""),
            contextId: String(message.contextId ?? ""),
          }
          const caller = String(metadata.caller ?? "a2a-client")
          if (!task.taskId) {
            send({
              type: "rpc",
              id,
              payload: { jsonrpc: "2.0", id, error: { code: -32602, message: "taskId required" } },
            })
            return
          }
          // DataPart → input-required 续聊应答（权限/提问）
          const dataPart = parts.find((p) => p.kind === "data")?.data as Record<string, unknown> | undefined
          if (dataPart) {
            const type = String(dataPart.type ?? "")
            const requestId = String(dataPart.requestId ?? dataPart.request_id ?? "")
            // dataPart.taskId = 轮次归属（监控轮 = roundKey；A2A 轮 = taskId），供应答后补状态事件
            const replyTaskId = String(dataPart.taskId ?? "") || task.taskId
            log(`a2a reply ${replyTaskId.slice(0, 8)}: ${type} ${requestId.slice(0, 12)}`)
            const run =
              type === "permission"
                ? onPermissionReply(requestId, String(dataPart.reply ?? "once") as "once" | "always" | "reject", replyTaskId)
                : type === "question"
                  ? onQuestionReply(requestId, (Array.isArray(dataPart.answers) ? dataPart.answers : []) as string[][], replyTaskId)
                  : Promise.reject(new Error(`unknown reply type: ${type}`))
            run
              .then(() => send({ type: "rpc", id, payload: { jsonrpc: "2.0", id, result: { ok: true } } }))
              .catch((e) =>
                send({
                  type: "rpc",
                  id,
                  payload: { jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } },
                }),
              )
            return
          }
          // 普通文本任务
          const text = parts
            .filter((p) => p.kind === "text")
            .map((p) => String(p.text ?? ""))
            .join("\n")
          if (!text) {
            send({
              type: "rpc",
              id,
              payload: { jsonrpc: "2.0", id, error: { code: -32602, message: "text required" } },
            })
            return
          }
          log(`a2a task ${task.taskId.slice(0, 8)} (caller=${caller})`)
          const serverSessionId = String(metadata.session_id ?? "")
          onTask(task, text, caller, serverSessionId)
            .then((sid) => {
              if (sid === null) {
                send({
                  type: "rpc",
                  id,
                  payload: { jsonrpc: "2.0", id, error: { code: -32000, message: "no session available" } },
                })
              } else {
                // 同步应答只确认接单；后续进展走 event 通道
                send({ type: "rpc", id, payload: { jsonrpc: "2.0", id, result: { sessionId: sid } } })
              }
            })
            .catch((e) => {
              send({
                type: "rpc",
                id,
                payload: { jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } },
              })
            })
        } else if (method === "tasks/cancel") {
          const taskId = String((params as Record<string, unknown>).id ?? "")
          log(`a2a cancel ${taskId.slice(0, 8)}`)
          onTaskCancel?.(taskId)
          send({ type: "rpc", id, payload: { jsonrpc: "2.0", id, result: {} } })
        } else {
          send({
            type: "rpc",
            id,
            payload: { jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${method}` } },
          })
        }
        break
      }
      default:
        break
    }
  }

  function connect() {
    if (closed) return
    if (typeof WebSocket === "undefined") {
      log("nexus disabled: no global WebSocket (node >= 22 required)")
      closed = true
      return
    }
    const wid = workspaceId()
    if (!wid) {
      // 还没注册工作区，晚点再试
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, 5_000)
      return
    }
    log(`nexus a2a connecting ${url}`)
    const socket = new WebSocket(url)
    ws = socket

    socket.addEventListener("open", () => {
      send({ type: "hello", apikey: apiKey, workspace_id: wid })
    })
    socket.addEventListener("message", (e: MessageEvent) => handle(String(e.data)))
    socket.addEventListener("close", () => {
      const wasReady = ready
      ready = false
      stopPing()
      if (ws === socket) ws = null
      if (closed) return
      log(wasReady ? "nexus disconnected, reconnecting" : "nexus connect failed, retrying")
      scheduleReconnect()
    })
    socket.addEventListener("error", () => {
      // close 事件随后触发，重连集中在那里处理
    })
  }

  connect()

  return {
    close() {
      closed = true
      ready = false
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      stopPing()
      try { ws?.close() } catch { /* ignore */ }
      ws = null
    },
    isReady: () => ready,
    send,
    sendMonitor: (payload) => sendMessage({ type: "monitor", payload }),
  }
}
