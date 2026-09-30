#!/usr/bin/env node
/** 一次性工作区注册器：调 agent_swarm MCP workspace_add + 写 .agent_swarm/workspace.md。
 * 用法：node register.mjs --server http://... --api-key as_... --path /abs/dir [--agent-type deepseek]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, basename } from "node:path"

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const server = (arg("server") ?? process.env.AGENT_SWARM_SERVER ?? "").replace(/\/+$/, "")
const apiKey = arg("api-key") ?? process.env.AGENT_SWARM_API_KEY ?? ""
const path = arg("path") ?? process.cwd()
const agentType = arg("agent-type") ?? "deepseek"

if (!server || !apiKey) {
  console.error("register.mjs: --server / --api-key required")
  process.exit(1)
}

async function callTool(name, args) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  const init = await fetch(`${server}/mcp/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dsh-agent-swarm", version: "0.1.0" } },
    }),
  })
  if (init.status === 401) throw new Error("invalid api key (401)")
  if (!init.ok) throw new Error(`initialize failed (${init.status})`)
  const r = await fetch(`${server}/mcp/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
  })
  if (!r.ok) throw new Error(`tools/call ${name} failed (${r.status})`)
  const body = await r.json()
  if (body.error) throw new Error(JSON.stringify(body.error))
  const result = body.result
  if (result?.isError) throw new Error(result?.content?.[0]?.text ?? "tool error")
  const sc = result?.structuredContent
  if (sc) return sc
  const content = result?.content ?? []
  try { return JSON.parse(content.map((c) => c.text).join("")) } catch { return content[0]?.text ?? {} }
}

const normPath = path.replace(/[\\/]+$/, "")
let purpose = ""
const agentsFile = join(normPath, "AGENTS.md")
if (existsSync(agentsFile)) {
  try {
    const first = readFileSync(agentsFile, "utf-8").split("\n").find((l) => l.startsWith("# "))
    if (first) purpose = first.replace(/^#\s*/, "").slice(0, 120)
  } catch { /* ignore */ }
}

const rsp = await callTool("workspace_add", {
  path: normPath.replace(/\\/g, "/"),
  purpose,
  name: basename(normPath),
})
const workspaceId = rsp.workspace_id ?? rsp.id ?? ""
if (!workspaceId) {
  console.error("register.mjs: no workspace_id in response:", JSON.stringify(rsp))
  process.exit(1)
}

// 写 .agent_swarm/workspace.md（与 opencode/claude 插件同一格式）
const dir = join(normPath, ".agent_swarm")
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
const file = join(dir, "workspace.md")
if (!existsSync(file)) {
  writeFileSync(file, `# agent_swarm\n\nPURPOSE: \nCAPABILITIES: \nWORKSPACE_ID: ${workspaceId}\n`, "utf-8")
} else {
  let text = readFileSync(file, "utf-8")
  if (/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+/im.test(text)) {
    text = text.replace(/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+.*$/im, `WORKSPACE_ID: ${workspaceId}`)
  } else {
    text = text.replace(/\s*$/, "") + `\nWORKSPACE_ID: ${workspaceId}\n`
  }
  writeFileSync(file, text, "utf-8")
}
console.log(`workspace registered: ${workspaceId} -> ${file}`)
