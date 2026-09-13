/** agent_swarm nexus WebSocket 客户端。
 *
 * 连接服务端 /ws/plugin，注册工作区后：
 * - 接收中枢（web nexus 页面）下发的 prompt 指令，注入前台会话执行
 * - 参考 opencode-feishu timeline 模式，把 opencode SSE 事件归一化为
 *   reasoning-updated / tool-state-changed / text-updated / session-idle
 *   上报给服务端，供 web 模拟 agent 界面渲染时间线
 *
 * 使用 Node 22+ 内置的全局 WebSocket（undici，浏览器风格事件 API），
 * 不引入 ws 包 —— 部署时插件 node_modules 直接 junction 复用 opencode 的依赖，
 * 额外 npm 依赖会装不上。
 */

export interface NexusClient {
  close: () => void
  isReady: () => boolean
  /** 在当前连接上发送原始消息（timeline 事件上报用）；未就绪返回 false */
  send: (obj: Record<string, unknown>) => boolean
}

export interface NexusOptions {
  /** ws(s)://host:port/ws/plugin */
  url: string
  apiKey: string
  workspaceId: () => string
  /** 收到 prompt 指令：注入会话执行，返回 sessionId */
  onCommand: (reqId: string, text: string, source: string) => Promise<string | null>
  /** 收到权限请求答复：调用 opencode permission API */
  onPermissionReply: (requestId: string, reply: "once" | "always" | "reject") => Promise<void>
  /** 收到问答回答（选择方案等）：answers 为 [[value], ...] */
  onQuestionReply: (requestId: string, answers: string[][]) => Promise<void>
  log: (msg: string) => void
}

const PING_INTERVAL_MS = 15_000
const MAX_RECONNECT_DELAY_MS = 15_000

/** timeline 事件（发给服务端 → web） */
export type TimelineEvent =
  | { kind: "run-started"; req_id: string; session_id: string; text: string; time: number }
  | { kind: "text-updated"; req_id: string; part_id: string; text: string; time: number }
  | { kind: "reasoning-updated"; req_id: string; part_id: string; text: string; time: number }
  | {
      kind: "tool-state-changed"
      req_id: string
      call_id: string
      tool: string
      state: "running" | "completed" | "error"
      input?: Record<string, unknown>
      output?: string
      time: number
    }
  | {
      kind: "permission-requested"
      req_id: string
      request_id: string
      session_id: string
      permission: string
      title: string
      time: number
    }
  | {
      kind: "question-requested"
      req_id: string
      request_id: string
      session_id: string
      question: string
      options: Array<{ label: string; value: string }>
      time: number
    }
  | { kind: "session-idle"; req_id: string; session_id: string; time: number }
  | { kind: "run-error"; req_id: string; error: string; time: number }

export function startNexusClient(options: NexusOptions): NexusClient {
  const { url, apiKey, workspaceId, onCommand, onPermissionReply, onQuestionReply, log } = options

  let ws: WebSocket | null = null
  let ready = false
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let reconnectDelay = 1_000

  function send(obj: Record<string, unknown>): boolean {
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
        log("nexus ready")
        break
      case "hello_err":
        log(`nexus hello rejected: ${msg.error}`)
        // 注册被拒（key 错 / 工作区不存在）不会自愈，停止重连
        closed = true
        try { ws?.close() } catch { /* ignore */ }
        break
      case "pong":
        break
      case "command": {
        const command = String(msg.command ?? "prompt")
        if (command === "permission_reply") {
          const requestId = String(msg.request_id ?? "")
          const reply = String(msg.reply ?? "") as "once" | "always" | "reject"
          if (!requestId || !["once", "always", "reject"].includes(reply)) break
          log(`nexus permission_reply ${requestId.slice(0, 12)}: ${reply}`)
          onPermissionReply(requestId, reply).catch((e) =>
            log(`nexus permission_reply failed: ${e}`),
          )
          break
        }
        if (command === "question_reply") {
          const requestId = String(msg.request_id ?? "")
          const answers = Array.isArray(msg.answers) ? (msg.answers as string[][]) : []
          if (!requestId || !answers.length) break
          log(`nexus question_reply ${requestId.slice(0, 12)}`)
          onQuestionReply(requestId, answers).catch((e) =>
            log(`nexus question_reply failed: ${e}`),
          )
          break
        }
        const reqId = String(msg.req_id ?? "")
        const text = String(msg.text ?? "")
        const source = String(msg.source ?? "nexus-web")
        if (!reqId || !text) break
        log(`nexus command ${reqId.slice(0, 8)} (source=${source})`)
        onCommand(reqId, text, source)
          .then((sid) => {
            if (!sid) send({ type: "result", req_id: reqId, ok: false, result: "no session" })
          })
          .catch((e) => send({ type: "result", req_id: reqId, ok: false, result: String(e) }))
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
    log(`nexus connecting ${url}`)
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
    send: (obj) => send(obj),
  }
}

/** 构造 timeline 事件消息（插件 → 服务端）。 */
export function sendTimeline(
  send: (obj: Record<string, unknown>) => boolean,
  event: TimelineEvent,
) {
  send({ type: "event", event })
}
