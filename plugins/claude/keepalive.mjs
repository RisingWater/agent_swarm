#!/usr/bin/env node
/** agent_swarm claude 保活进程：以本地 stdio MCP server 形式被 claude spawn，
 * spawn 即开始心跳循环（agent_type=claude），claude 退出（stdin 关闭/父进程死亡）
 * 后进程自行退出，工作区靠服务端 90s 心跳超时转为离线。
 *
 * MCP 协议：最小 JSON-RPC 应答（initialize / ping / tools/list），
 * 不引入 SDK —— 保持零依赖，node 直接跑。
 *
 * 配置：~/.claude/agent-swarm/config.json（install-claude 脚本写入），
 * 环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY 可覆盖。
 * 工作区 ID：每轮心跳从 process.cwd() 的 .agent-swarm.md 重读
 * （MCP 子进程 cwd = claude 启动目录），/swarm-add 换 ID 后无需重启。
 *
 * 日志：~/.claude/agent-swarm/keepalive.log（不进 claude 控制台，stdout 是协议通道）。
 */
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HEARTBEAT_MS = 30_000
const LOG_MAX_BYTES = 500_000

// ---------------- 日志 ----------------
const LOG_FILE = join(homedir(), ".claude", "agent-swarm", "keepalive.log")

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

// ---------------- 配置 ----------------
function loadConfig() {
  let fileCfg = {}
  const file = join(homedir(), ".claude", "agent-swarm", "config.json")
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
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "claude-agent-swarm-keepalive", version: "0.1.0" },
        },
      }),
    })
    if (init.status === 401) throw new Error("invalid api key (401)")
    if (!init.ok) throw new Error(`initialize failed (${init.status})`)

    const sid = init.headers.get("mcp-session-id")
    if (sid) {
      await fetch(`${this.baseUrl}/mcp/`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }).catch(() => {})
    }

    const r = await fetch(`${this.baseUrl}/mcp/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
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
      try {
        return JSON.parse(content[0].text)
      } catch {
        return content[0].text
      }
    }
    return {}
  }

  heartbeat(workspaceId, sessionId) {
    return this.callTool("heartbeat", {
      workspace_id: workspaceId,
      session_id: sessionId ?? "",
      agent_type: "claude",
    })
  }
}

// ---------------- 心跳循环 ----------------
let disposed = false

async function heartbeatLoop(cfg) {
  const swarm = new SwarmClient(cfg)
  log(`start: cwd=${process.cwd()}`)
  while (!disposed) {
    try {
      const id = readWorkspaceId(process.cwd())
      if (id) {
        const rsp = await swarm.heartbeat(id, "")
        const calls = rsp?.calls ?? []
        if (calls.length) log(`heartbeat: ${calls.length} pending call(s) skipped (claude 不支持任务执行)`)
      }
    } catch (e) {
      log(`heartbeat failed: ${e}`)
    }
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS))
  }
}

// ---------------- 最小 stdio MCP server ----------------
// claude spawn 本进程后走 JSON-RPC 握手；不响应会导致 server 标记 failed。
// 协议按行分隔 JSON：initialize 必答（声明无能力），tools/list 返回空列表，
// ping 回空结果，notifications 忽略。stdout 只允许写协议消息。

let rpcSeq = 100

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n")
  } catch {
    // stdout 断开时由 stdin close / ppid 轮询负责退出
  }
}

function handleRequest(msg) {
  const { id, method } = msg
  if (id === undefined || id === null) return // notification，忽略

  let result = {}
  switch (method) {
    case "initialize":
      result = {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-swarm-keepalive", version: "0.1.0" },
      }
      break
    case "ping":
      result = {}
      break
    case "tools/list":
      result = { tools: [] }
      break
    default:
      // 未知请求：返回方法不存在错误（协议要求必须有响应）
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
      rpcSeq++
      return
  }
  send({ jsonrpc: "2.0", id, result })
  rpcSeq++
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
    try {
      handleRequest(JSON.parse(line))
    } catch {
      // 非 JSON 行忽略
    }
  }
})

// ---------------- 退出检测：stdin close + ppid 轮询双保险 ----------------
function shutdown(reason) {
  if (disposed) return
  disposed = true
  log(`exit: ${reason}`)
  process.exit(0)
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
if (!cfg) {
  log("no apiKey config; keepalive idle (MCP still answering)")
} else {
  heartbeatLoop(cfg).catch((e) => log(`heartbeat loop crashed: ${e}`))
}
