import { readFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

export async function loadConfig() {
  return JSON.parse(await readFile(new URL("./swarm.json", import.meta.url), "utf8"))
}

export async function sendMcp(config, message) {
  const wait = message.params?.name === "a2a_call" && Number(message.params.arguments?.wait_seconds)
  const timeout = 20_000 + (Number.isFinite(wait) ? Math.max(0, Math.min(wait, 3600)) * 1000 : 0)
  const response = await fetch(new URL(config.server + "/mcp/"), {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(Math.ceil(timeout)),
  })
  if (!response.ok) throw new Error(`Swarm MCP HTTP ${response.status}`)
  return response.json()
}

export async function callTool(config, name, args) {
  const init = await sendMcp(config, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-swarm-worker", version: "0.1.0" } },
  })
  if (init.error) throw new Error(init.error.message)
  const { result, error } = await sendMcp(config, {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args },
  })
  if (error || result?.isError) throw new Error(error?.message ?? result.content?.[0]?.text ?? name)
  return result.structuredContent ?? JSON.parse(result.content[0].text)
}

// 只转发客户端请求，保留中心 MCP 工具定义和响应。中心是无状态 JSON HTTP。
export function serveMcp(config, input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on("line", async line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (!message || message.id === undefined) return
    try {
      output.write(JSON.stringify(await sendMcp(config, message)) + "\n")
    } catch {
      output.write(JSON.stringify({
        jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Swarm MCP 请求失败" },
      }) + "\n")
    }
  })
  return lines
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    serveMcp(await loadConfig()).on("close", () => process.exit(0))
  } catch {
    console.error("无法读取 Codex Swarm 配置")
    process.exitCode = 1
  }
}
