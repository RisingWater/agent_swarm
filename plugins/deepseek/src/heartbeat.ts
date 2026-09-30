/** agent_swarm MCP 心跳客户端（HTTP JSON-RPC，每次独立 initialize，服务端 stateless）。
 * 与 register.mjs / opencode 插件 SwarmClient 同款协议；仅心跳用（任务走 WS）。 */

import type { SwarmConfig } from "./config.ts"

export class SwarmHeartbeat {
  private baseUrl: string
  private apiKey: string

  constructor(cfg: SwarmConfig) {
    this.baseUrl = cfg.serverUrl.replace(/\/+$/, "")
    this.apiKey = cfg.apiKey
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }
  }

  /** 调用 MCP 工具。每次独立 initialize（服务端 stateless）。 */
  async callTool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
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
          clientInfo: { name: "dsh-agent-swarm", version: "0.1.0" },
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
    if (result?.isError) throw new Error(`agent_swarm: ${result?.content?.[0]?.text ?? "tool error"}`)
    const sc = result?.structuredContent
    if (sc && typeof sc === "object") return sc as T
    const content = result?.content ?? []
    if (content.length === 0) return {} as T
    try {
      return JSON.parse(content.map((c: any) => c.text).join("")) as T
    } catch {
      return content[0]?.text as T
    }
  }

  heartbeat(workspaceId: string, sessionId: string, sessionTitle: string): Promise<{ ok: boolean; status: string }> {
    return this.callTool("heartbeat", {
      workspace_id: workspaceId,
      session_id: sessionId,
      session_title: sessionTitle,
      agent_type: "deepseek",
    })
  }
}
