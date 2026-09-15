/** agent_swarm claude A2A 插件客户端（JSON-RPC/A2A over WebSocket，零依赖）。
 *
 * 连接服务端 /ws/plugin，注册工作区后：
 * - 接收服务端转发的 A2A JSON-RPC request（message/send），交由 background.mjs 执行
 *   （claude 仅后台会话模式：spawn `claude -p` headless 进程）
 * - 流式事件（思考/文本/工具）归一化为 A2A TaskStatusUpdateEvent /
 *   TaskArtifactUpdateEvent 上报；完成时发 completed + final Artifact
 *
 * 事件形状对齐 A2A 0.3.x 规范（camelCase + kind 判别符），与 opencode 插件同构。
 * 使用 Node 22+ 内置全局 WebSocket，不引入依赖。
 */

// ---------------------------------------------------------------- A2A 事件构造

/** status-update 事件 */
export function statusUpdate(task, state, opts = {}) {
  const status = { state }
  if (opts.message) status.message = opts.message
  const ev = {
    taskId: task.taskId,
    contextId: task.contextId,
    kind: "status-update",
    status,
    final: opts.final ?? false,
  }
  if (opts.metadata) ev.metadata = opts.metadata
  return ev
}

/** agent 消息对象（失败原因等） */
export function agentMessage(text, task) {
  return {
    role: "agent",
    parts: [{ kind: "text", text }],
    messageId: `msg-${task.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.taskId,
    contextId: task.contextId,
  }
}

/** 最终结果 artifact（lastChunk 全量文本） */
export function artifactUpdate(task, text, lastChunk, artifactId) {
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

/** 工具执行状态事件（metadata.nexus=tool，web 直接透传渲染） */
export function toolStatus(task, tool) {
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

/** 思考/文本流式片段（metadata.nexus=text/reasoning）。
 *  mode: "append"=增量 delta（前端拼接累积），"replace"=全量快照（前端覆盖）。
 *  claude stream-json 的 *_delta 是增量；opencode part 是全量快照。 */
export function streamStatus(task, kind, partId, text, mode = "append") {
  return statusUpdate(task, "working", {
    metadata: { nexus: kind, part_id: partId, text, mode },
  })
}

function taskRef(taskId) {
  return { taskId, contextId: taskId }
}

// ---------------------------------------------------------------- 客户端主体

const PING_INTERVAL_MS = 15_000
const MAX_RECONNECT_DELAY_MS = 15_000

/**
 * 启动 A2A WS 客户端。
 * options:
 *   url          ws(s)://host:port/ws/plugin
 *   apiKey       用户 apikey
 *   workspaceId  () => string（每轮重读，/swarm-add 换 ID 无需重启）
 *   onTask       (task, text, caller) => Promise<string|null>  执行任务，返回 sessionId 或 null
 *   onTaskCancel (taskId) => void
 *   log          (msg) => void
 */
export function startNexusA2AClient(options) {
  const { url, apiKey, workspaceId, onTask, onTaskCancel, log } = options

  let ws = null
  let ready = false
  let closed = false
  let reconnectTimer = null
  let pingTimer = null
  let reconnectDelay = 1_000

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
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

  function rpcError(id, code, message) {
    send({ type: "rpc", id, payload: { jsonrpc: "2.0", id, error: { code, message } } })
  }

  function handle(raw) {
    let msg
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
        const payload = msg.payload ?? {}
        const method = String(payload.method ?? "")
        const id = String(payload.id ?? "")
        const params = payload.params ?? {}
        if (method === "message/send") {
          const message = params.message ?? {}
          const metadata = params.metadata ?? {}
          const parts = message.parts ?? []
          const task = {
            taskId: String(message.taskId ?? ""),
            contextId: String(message.contextId ?? ""),
          }
          const caller = String(metadata.caller ?? "a2a-client")
          if (!task.taskId) {
            rpcError(id, -32602, "taskId required")
            return
          }
          // DataPart（input-required 续聊应答）：claude 后台模式不支持交互应答
          const dataPart = parts.find((p) => p.kind === "data")?.data
          if (dataPart) {
            rpcError(id, -32000, "claude background tasks do not support interactive replies")
            return
          }
          const text = parts
            .filter((p) => p.kind === "text")
            .map((p) => String(p.text ?? ""))
            .join("\n")
          if (!text) {
            rpcError(id, -32602, "text required")
            return
          }
          log(`a2a task ${task.taskId.slice(0, 8)} (caller=${caller})`)
          Promise.resolve()
            .then(() => onTask(task, text, caller))
            .then((sid) => {
              if (sid === null) {
                rpcError(id, -32000, "task execution failed")
              } else {
                // 同步应答只确认接单；后续进展走 event 通道
                send({ type: "rpc", id, payload: { jsonrpc: "2.0", id, result: { sessionId: sid } } })
              }
            })
            .catch((e) => rpcError(id, -32000, String(e)))
        } else if (method === "tasks/cancel") {
          const taskId = String(params.id ?? "")
          log(`a2a cancel ${taskId.slice(0, 8)}`)
          try { onTaskCancel?.(taskId) } catch { /* ignore */ }
          send({ type: "rpc", id, payload: { jsonrpc: "2.0", id, result: {} } })
        } else {
          rpcError(id, -32601, `method not supported: ${method}`)
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
    socket.addEventListener("message", (e) => handle(String(e.data)))
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
  }
}

export { taskRef }
