/** agent_swarm nexus A2A 插件客户端（deepseek harness 版，JSON-RPC/A2A over WebSocket）。
 *
 * 从 plugins/opencode/src/nexus_a2a.ts 精简：deepseek 插件无 execution_mode
 * 之分（进程常驻即在线，任务执行在宿主进程内），去掉 monitor/executionMode。
 *
 * - 接收服务端转发的 A2A JSON-RPC request（message/send），交给 onTask 执行
 * - 事件（working/text/reasoning/tool/input-required/artifact/completed）经
 *   sendEvent 上行；断连入缓冲，重连补发
 * - 使用 Node 22+ 内置全局 WebSocket，零依赖
 */

export interface NexusA2AClient {
  close: () => void
  isReady: () => boolean
  send: (obj: Record<string, unknown>) => boolean
  /** A2A 事件上行（断连入缓冲，重连补发） */
  sendEvent: (payload: Record<string, unknown>) => void
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
  /** 任务执行模式（foreground/background）。服务端 dispatchable 据此判断：心跳过期时
   * 只有 background 的工作区仍可派任务。hello 与 ping 都带上（热切换即时生效） */
  executionMode?: () => string
  /** 收到 message/send：执行任务。onAccepted：已锚定会话时立即回 ack（服务端只等 30s） */
  onTask: (
    task: A2aTaskRef,
    text: string,
    caller: string,
    serverSessionId: string | undefined,
    onAccepted?: (sessionId: string) => void,
  ) => Promise<string | null>
  /** 收到 input-required 续聊应答（权限/提问） */
  onReply: (task: A2aTaskRef, data: { type: string; requestId: string; reply?: string; answers?: string[][] }) => Promise<void>
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

/** 工具执行状态事件（metadata.nexus=tool，服务端/web 直接透传渲染） */
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

/** 思考/文本流式片段（mode: replace=全量快照 / append=增量 delta） */
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

// ---------------------------------------------------------------- 客户端主体

export function startNexusA2AClient(options: A2aOptions): NexusA2AClient {
  const { url, apiKey, workspaceId, onTask, onReply, onTaskCancel, log } = options

  let ws: WebSocket | null = null
  let ready = false
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let reconnectDelay = 1_000
  /** WS 断连期间的 event 缓冲（重连后补发，上限防内存失控） */
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

  /** event 发送：断连时入缓冲，重连后 flush */
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
    pingTimer = setInterval(() => send({ type: "ping", execution_mode: options.executionMode?.() }), PING_INTERVAL_MS)
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
            const replyTaskId = String(dataPart.taskId ?? "") || task.taskId
            log(`a2a reply ${replyTaskId.slice(0, 8)}: ${type} ${requestId.slice(0, 12)}`)
            const run =
              type === "permission"
                ? onReply(task, { type, requestId, reply: String(dataPart.reply ?? "once"), })
                : type === "question"
                  ? onReply(task, { type, requestId, answers: (Array.isArray(dataPart.answers) ? dataPart.answers : []) as string[][] })
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
          let acked = false
          const ackNow = (sid: string) => {
            if (acked) return
            acked = true
            // 接单即回 ack（服务端 dispatch 等 30s）：后续进展走 event 通道
            send({ type: "rpc", id, payload: { jsonrpc: "2.0", id, result: { sessionId: sid } } })
          }
          onTask(task, text, caller, serverSessionId, ackNow)
            .then((sid) => {
              if (sid === null) {
                if (!acked) {
                  send({
                    type: "rpc",
                    id,
                    payload: { jsonrpc: "2.0", id, error: { code: -32000, message: "no session available" } },
                  })
                }
              } else {
                ackNow(sid) // 已在 onAccepted 回过则幂等跳过；兜底在此回
              }
            })
            .catch((e) => {
              if (!acked) {
                send({
                  type: "rpc",
                  id,
                  payload: { jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } },
                })
              }
              // 已 ack 过才失败的：终态走 event 通道（executeTask 已发 failed status-update）
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
      send({ type: "hello", apikey: apiKey, workspace_id: wid, execution_mode: options.executionMode?.() ?? "foreground" })
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
    sendEvent: (payload) => sendMessage({ type: "event", payload }),
  }
}
