#!/usr/bin/env node
/** agent_swarm claude 保活进程：以本地 stdio MCP server 形式被 claude spawn。
 *
 * v2（channel 模式）：声明 experimental.claude/channel capability + tools，
 * 四条职责：
 *   1. 心跳保活：30s heartbeat（agent_type=claude），响应捎带 pending calls
 *   2. 任务注入：收到 call → channel notification 注入 TUI（meta.call_id），
 *      prompt 要求 claude 完成后调 swarm_reply 工具回传结果
 *   3. nexus 直连：WebSocket 连 /ws/plugin，收网页中枢指令（秒级）、上报 timeline 事件
 *   4. swarm_reply 工具：claude 调用 → workspace_call_result 提交 + 清除执行状态
 *
 * 注意：channel notification 只有在用户以
 *   claude --dangerously-load-development-channels server:agent-swarm-keepalive
 * 启动时才会进入会话；未带 flag 时注入被静默丢弃，任务靠超时收尾。
 *
 * hooks 协作（见 hook-timeline.mjs）：注入任务时写 state.json（active 执行状态），
 * hook 脚本据此门控事件上报（避免用户自己的工具调用泄进远端时间线）。
 *
 * MCP 协议：最小 JSON-RPC 应答（initialize / ping / tools/list / tools/call），
 * 不引入 SDK —— 保持零依赖，node 直接跑。
 * 日志：~/.claude/agent-swarm/keepalive.log（stdout 是协议通道，日志只进文件）。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HEARTBEAT_MS = 30_000
const CALL_TIMEOUT_MS = 60 * 60_000 // 对齐服务端 AGENT_SWARM_CALL_TIMEOUT 默认 1h
const LOG_MAX_BYTES = 1_000_000
const WS_PING_MS = 15_000
const WS_RECONNECT_MAX_MS = 15_000

const SWARM_DIR = join(homedir(), ".claude", "agent-swarm")
const LOG_FILE = join(SWARM_DIR, "keepalive.log")
const STATE_FILE = join(SWARM_DIR, "state.json")

// ---------------- 日志 ----------------

function log(msg) {
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

// ---------------- 配置与工作区 ID ----------------

function loadConfig() {
  let fileCfg = {}
  const file = join(SWARM_DIR, "config.json")
  if (existsSync(file)) {
    try {
      fileCfg = JSON.parse(readFileSync(file, "utf-8"))
    } catch {
      // 配置文件损坏时忽略，继续读环境变量
    }
  }
  const cfg = {
    serverUrl: fileCfg.serverUrl ?? process.env.AGENT_SWARM_SERVER ?? "http://127.0.0.1:8700",
    apiKey: fileCfg.apiKey ?? process.env.AGENT_SWARM_API_KEY ?? "",
  }
  return cfg.apiKey ? cfg : null
}

/** 读 <dir>/.agent-swarm.md 的 WORKSPACE_ID: 行（与 opencode 插件同一文件格式） */
function readWorkspaceId(dir) {
  const file = join(dir, ".agent-swarm.md")
  if (!existsSync(file)) return ""
  try {
    return readFileSync(file, "utf-8")
      .match(/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*([A-Za-z0-9_-]+)/im)?.[1] ?? ""
  } catch {
    return ""
  }
}

// ---------------- 执行状态（state.json，hooks 门控用） ----------------
// {active: true, req_id, source: "call"|"nexus", started_at}
// swarm_reply 到达时清除（进程内最及时）；Stop hook 触发的 turn-end 兜底；超时最后防线。

let activeState = null

function writeState() {
  try {
    if (activeState) writeFileSync(STATE_FILE, JSON.stringify(activeState), "utf-8")
    else if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE)
  } catch { /* 忽略 */ }
}

function setActive(reqId, source) {
  activeState = { active: true, req_id: reqId, source, started_at: Date.now() }
  writeState()
}

function clearActive(reqId) {
  // reqId 不匹配时不清除（防止串扰；单会话场景二者恒相等）
  if (activeState && reqId && activeState.req_id !== reqId) return
  activeState = null
  writeState()
}

// ---------------- 服务端 API（MCP JSON-RPC over HTTP，每次独立 initialize） ----------------

class SwarmClient {
  constructor(cfg) {
    this.baseUrl = cfg.serverUrl.replace(/\/+$/, "")
    this.apiKey = cfg.apiKey
  }

  headers(json = true) {
    const h = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json, text/event-stream",
    }
    if (json) h["Content-Type"] = "application/json"
    return h
  }

  async callTool(name, args) {
    const init = await fetch(`${this.baseUrl}/mcp/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "claude-agent-swarm-keepalive", version: "0.2.0" },
        },
      }),
    })
    if (init.status === 401) throw new Error("invalid api key (401)")
    if (!init.ok) throw new Error(`initialize failed (${init.status})`)
    const sid = init.headers.get("mcp-session-id")
    if (sid) {
      await fetch(`${this.baseUrl}/mcp/`, {
        method: "POST", headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }).catch(() => {})
    }
    const r = await fetch(`${this.baseUrl}/mcp/`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    })
    if (!r.ok) throw new Error(`tools/call ${name} failed (${r.status})`)
    const body = await r.json()
    if (body.error) throw new Error(JSON.stringify(body.error))
    const result = body.result
    if (result?.isError) throw new Error(result?.content?.[0]?.text ?? "tool error")
    const sc = result?.structuredContent
    if (sc && typeof sc === "object") return sc
    const content = result?.content ?? []
    if (content.length === 1) {
      try { return JSON.parse(content[0].text) } catch { return content[0].text }
    }
    return {}
  }

  heartbeat(workspaceId) {
    return this.callTool("heartbeat", { workspace_id: workspaceId, session_id: "", agent_type: "claude" })
  }

  ackCall(callId) { return this.callTool("workspace_call_ack", { call_id: callId, session_id: "" }) }
  submitCallResult(callId, ok, result) { return this.callTool("workspace_call_result", { call_id: callId, ok, result }) }
}

/** hook 脚本走的 HTTP 事件上报通道（timeline 事件，协议同 /ws/plugin 的 event 消息） */
async function reportHookEvent(cfg, workspaceId, event) {
  try {
    const r = await fetch(`${cfg.serverUrl.replace(/\/+$/, "")}/api/nexus/hook-events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, event }),
    })
    if (!r.ok) log(`hook-event report failed (${r.status})`)
  } catch (e) {
    log(`hook-event report failed: ${e}`)
  }
}

// ---------------- 任务队列（call + nexus 共用执行状态） ----------------

const pendingCalls = new Map() // call_id → {started_at, timer}
let seqCounter = 0
function nextReqId(prefix) {
  seqCounter++
  return `${prefix}-${Date.now().toString(36)}-${seqCounter}`
}

function buildCallPrompt(call) {
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
    `2. 完成后必须调用 swarm_reply 工具回传结果（参数 call_id="${call.call_id}"，result=一段话总结：做了什么/结论/改动点）。不要用其他方式回传。`,
    "3. 无法完成时，也调用 swarm_reply 并在 result 里说明原因。",
  ].join("\n")
}

/** 注入任务文本到 TUI 会话（channel notification；未带 flag 时被静默丢弃） */
function channelNotify(text, meta) {
  if (!mcpReady) {
    log(`channel notify dropped (not ready): ${text.slice(0, 60)}`)
    return false
  }
  send({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: text, meta: meta ?? {} },
  })
  return true
}

function registerCallTimeout(callId) {
  const timer = setTimeout(() => {
    if (!pendingCalls.has(callId)) return
    pendingCalls.delete(callId)
    clearActive(callId)
    log(`call ${callId}: timeout (60min), marking failed`)
    swarm.submitCallResult(callId, false, "执行超时（60 分钟未收到 swarm_reply）").catch(() => {})
    nexusEmit({ kind: "run-error", req_id: callId, error: "执行超时", time: Date.now() })
  }, CALL_TIMEOUT_MS)
  return timer
}

/** 心跳捎带的 pending call → 注入 */
function handleIncomingCall(call) {
  if (pendingCalls.has(call.call_id)) return
  pendingCalls.set(call.call_id, { started_at: Date.now(), timer: registerCallTimeout(call.call_id) })
  setActive(call.call_id, "call")
  const ok = channelNotify(buildCallPrompt(call), { call_id: call.call_id })
  log(`call ${call.call_id}: injected=${ok}`)
  nexusEmit({ kind: "run-started", req_id: call.call_id, session_id: "", text: call.instruction, time: Date.now() })
  if (!ok) log(`call ${call.call_id}: NOT delivered — did you start claude with --dangerously-load-development-channels?`)
}

function submitReply(callId, result) {
  const entry = pendingCalls.get(callId)
  if (!entry) {
    log(`swarm_reply: unknown/finished call ${callId}`)
    return "unknown call_id（可能已提交或超时）"
  }
  clearTimeout(entry.timer)
  pendingCalls.delete(callId)
  clearActive(callId)
  swarm.submitCallResult(callId, true, result).catch((e) => log(`call ${callId}: result submit failed: ${e}`))
  nexusEmit({ kind: "text-updated", req_id: callId, part_id: `reply-${callId}`, text: result, time: Date.now() })
  nexusEmit({ kind: "session-idle", req_id: callId, session_id: "", time: Date.now() })
  log(`call ${callId}: done via swarm_reply (${result.length} chars)`)
  return "ok"
}

// ---------------- nexus WebSocket（/ws/plugin，收中枢指令 + 上报 timeline） ----------------

let nexusWs = null
let nexusReady = false
let nexusReconnectDelay = 1_000
let nexusReconnectTimer = null
let nexusPingTimer = null
const pendingQuestionAnswers = new Map() // req_id → answer payload（hook 轮询读取用文件，见 writeAnswer）

function nexusSend(obj) {
  if (!nexusWs || nexusWs.readyState !== 1) return false
  try { nexusWs.send(JSON.stringify(obj)); return true } catch { return false }
}

function nexusEmit(event) {
  if (!event.req_id) return
  nexusSend({ type: "event", event })
}

/** nexus 指令 / call 的 question_reply 落盘，供 PreToolUse hook（AskUserQuestion）轮询 */
function writeAnswer(reqId, answers) {
  const file = join(SWARM_DIR, `answer-${reqId}.json`)
  try { writeFileSync(file, JSON.stringify({ answers, at: Date.now() }), "utf-8") } catch { /* 忽略 */ }
  pendingQuestionAnswers.set(reqId, file)
  // 半小时无人消费则清理
  setTimeout(() => {
    pendingQuestionAnswers.delete(reqId)
    try { unlinkSync(file) } catch { /* 已被 hook 消费删除 */ }
  }, 30 * 60_000).unref()
}

function nexusConnect() {
  if (disposed) return
  if (typeof WebSocket === "undefined") { log("nexus disabled: no WebSocket global"); return }
  const wid = readWorkspaceId(process.cwd())
  if (!wid) {
    nexusReconnectTimer = setTimeout(nexusConnect, 5_000)
    return
  }
  const wsUrl = cfg.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws/plugin"
  log(`nexus connecting ${wsUrl}`)
  const ws = new WebSocket(wsUrl)
  nexusWs = ws

  ws.addEventListener("open", () => {
    nexusSend({ type: "hello", apikey: cfg.apiKey, workspace_id: wid })
  })
  ws.addEventListener("message", (e) => {
    let msg
    try { msg = JSON.parse(String(e.data)) } catch { return }
    switch (msg.type) {
      case "hello_ok":
        nexusReady = true
        nexusReconnectDelay = 1_000
        log("nexus ws ready")
        break
      case "hello_err":
        log(`nexus hello rejected: ${msg.error}`)
        try { ws.close() } catch { /* ignore */ }
        nexusWs = null
        return // 不重连（key 错/工作区不对不会自愈）
      case "pong":
        break
      case "command": {
        if (msg.command === "permission_reply") break // 权限中继 v1 不做
        if (msg.command === "question_reply") {
          const reqId = String(msg.request_id ?? "")
          const answers = Array.isArray(msg.answers) ? msg.answers : []
          if (reqId && answers.length) {
            log(`nexus question_reply ${reqId.slice(0, 12)}`)
            writeAnswer(reqId, answers)
          }
          break
        }
        // prompt 指令 → channel 注入
        const reqId = String(msg.req_id ?? "")
        const text = String(msg.text ?? "")
        const source = String(msg.source ?? "nexus-web")
        if (!reqId || !text) break
        log(`nexus command ${reqId.slice(0, 12)} (source=${source})`)
        setActive(reqId, "nexus")
        const prompt = `[来自 ${source} 的指令]\n\n${text}\n\n（处理要求：完成上述任务后，直接输出一段话总结即可，系统会自动回传，不要调用任何工具回传。）`
        const ok = channelNotify(prompt, { req_id: reqId })
        nexusEmit({ kind: "run-started", req_id: reqId, session_id: "", text, time: Date.now() })
        if (!ok) {
          nexusEmit({ kind: "run-error", req_id: reqId, error: "channel 未就绪（需带 --dangerously-load-development-channels 启动）", time: Date.now() })
          clearActive(reqId)
        }
        break
      }
      default:
        break
    }
  })
  ws.addEventListener("close", () => {
    const wasReady = nexusReady
    nexusReady = false
    if (nexusWs === ws) nexusWs = null
    if (disposed) return
    log(wasReady ? "nexus ws closed, reconnecting" : "nexus ws connect failed, retrying")
    nexusReconnectTimer = setTimeout(nexusConnect, nexusReconnectDelay)
    nexusReconnectDelay = Math.min(nexusReconnectDelay * 2, WS_RECONNECT_MAX_MS)
  })
  ws.addEventListener("error", () => { /* close 随后触发 */ })
}

// ---------------- 最小 stdio MCP server ----------------
// claude spawn 本进程后走 JSON-RPC 握手；不响应会导致 server 标记 failed。
// stdout 只允许写协议消息。

let mcpReady = false // initialize 完成后才发 channel notification

function send(msg) {
  try { process.stdout.write(JSON.stringify(msg) + "\n") } catch { /* 断开由退出检测兜底 */ }
}

const swarmReplySchema = {
  name: "swarm_reply",
  description: "回传 agent_swarm 调用任务的结果。收到 <channel source=\"agent-swarm-keepalive\" call_id=\"...\"> 注入的任务后，完成时必须调用本工具（call_id 取自标签属性，result=一段话总结）。不要用于其他场景。",
  inputSchema: {
    type: "object",
    properties: {
      call_id: { type: "string", description: "任务 ID（<channel> 标签的 call_id 属性）" },
      result: { type: "string", description: "结果总结（做了什么/结论/改动点）" },
    },
    required: ["call_id", "result"],
  },
}

function handleRequest(msg) {
  const { id, method } = msg
  if (id === undefined || id === null) return // notification，忽略

  let result = {}
  switch (method) {
    case "initialize":
      result = {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: {
          experimental: { "claude/channel": {} },
          tools: {},
        },
        serverInfo: { name: "agent-swarm-keepalive", version: "0.2.0" },
        // claude 连接时把这段投给模型作为上下文：说明事件语义与回传方式
        instructions:
          'agent_swarm 任务通过 <channel source="agent-swarm-keepalive" call_id="..."> 注入。' +
          "处理要求已在任务文本中给出；完成任务后必须调用 swarm_reply 工具回传（call_id 取自标签，result=一段话总结），不要用其他方式回传。" +
          "若上下文中存在进行中的 swarm 任务，工具调用与提问都会被同步给发起方。",
      }
      mcpReady = true
      break
    case "ping":
      result = {}
      break
    case "tools/list":
      result = { tools: [swarmReplySchema] }
      break
    case "tools/call": {
      if (msg.params?.name === "swarm_reply") {
        const args = msg.params.arguments ?? {}
        const callId = String(args.call_id ?? "")
        const text = String(args.result ?? "")
        if (!callId || !text) {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "error: call_id 与 result 必填" }], isError: true } })
          return
        }
        const reply = submitReply(callId, text)
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reply }] } })
        return
      }
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${msg.params?.name}` }], isError: true } })
      return
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
      return
  }
  send({ jsonrpc: "2.0", id, result })
}

let buf = ""
process.stdin.setEncoding("utf-8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try { handleRequest(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
  }
})

// ---------------- 心跳循环 ----------------

let disposed = false

async function heartbeatLoop() {
  log(`heartbeat loop start: cwd=${process.cwd()}`)
  while (!disposed) {
    try {
      const id = readWorkspaceId(process.cwd())
      if (id) {
        const rsp = await swarm.heartbeat(id)
        const calls = rsp?.calls ?? []
        if (calls.length) log(`heartbeat: ${calls.length} pending call(s)`)
        for (const call of calls) {
          try { handleIncomingCall(call) } catch (e) { log(`call dispatch failed: ${e}`) }
        }
      }
    } catch (e) {
      log(`heartbeat failed: ${e}`)
    }
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS))
  }
}

// ---------------- 退出检测：stdin close + ppid 轮询双保险 ----------------

async function goOffline() {
  const id = readWorkspaceId(process.cwd())
  if (!id) return
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 3_000)
    const baseUrl = cfg.serverUrl.replace(/\/+$/, "")
    const post = (body) =>
      fetch(`${baseUrl}/mcp/`, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      })
    const init = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-agent-swarm-keepalive", version: "0.2.0" } },
    })
    clearTimeout(timer)
    if (!init.ok) return
    const ctl2 = new AbortController()
    const timer2 = setTimeout(() => ctl2.abort(), 3_000)
    await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace_offline", arguments: { workspace_id: id } } }).catch(() => {})
    clearTimeout(timer2)
    log(`offline notification sent for ${id}`)
  } catch {
    // 网络失败无所谓：90s 心跳超时兜底
  }
}

function shutdown(reason) {
  if (disposed) return
  disposed = true
  log(`exit: ${reason}`)
  // 把未完成的 pending call 标记失败（claude 都退了，等不到了）
  for (const [callId, entry] of pendingCalls) {
    clearTimeout(entry.timer)
    swarm.submitCallResult(callId, false, "claude 会话退出，任务中断").catch(() => {})
    log(`call ${callId}: aborted on exit`)
  }
  pendingCalls.clear()
  writeState()
  const work = goOffline().finally(() => {
    try { process.exit(0) } catch { /* ignore */ }
  })
  // 兜底：最多再等 4s 强制退出，防止网络挂起拖住进程
  setTimeout(() => { try { process.exit(0) } catch { /* ignore */ } }, 4_000).unref()
}

process.stdin.on("close", () => shutdown("stdin closed"))
// 兜底：claude 进程异常死亡时 stdin 可能不触发 close，轮询父进程
const ppid = process.ppid
setInterval(() => {
  try {
    if (process.ppid !== ppid) shutdown("parent changed")
  } catch {
    shutdown("parent check failed")
  }
}, 5_000).unref()
process.on("SIGTERM", () => shutdown("sigterm"))
process.on("SIGINT", () => shutdown("sigint"))

// ---------------- 启动 ----------------

const cfg = loadConfig()
var loadedCfg = cfg
let swarm = cfg ? new SwarmClient(cfg) : null

if (!cfg) {
  log("no apiKey config; keepalive idle (MCP still answering)")
} else {
  heartbeatLoop().catch((e) => log(`heartbeat loop crashed: ${e}`))
  nexusConnect()
}
