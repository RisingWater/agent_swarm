/** agent_swarm 服务端 API 客户端（MCP JSON-RPC over HTTP），仅插件心跳用 */

export interface SwarmConfig {
  serverUrl: string
  apiKey: string
  heartbeatIntervalMs?: number
}

export class SwarmClient {
  private baseUrl: string
  private apiKey: string

  constructor(cfg: { serverUrl: string; apiKey: string }) {
    this.baseUrl = cfg.serverUrl.replace(/\/+$/, "")
    this.apiKey = cfg.apiKey
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json, text/event-stream",
    }
    if (json) h["Content-Type"] = "application/json"
    return h
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
          clientInfo: { name: "opencode-agent-swarm", version: "0.2.0" },
        },
      }),
    })
    if (init.status === 401) throw new Error("agent_swarm: invalid api key (401)")
    if (!init.ok) throw new Error(`agent_swarm: initialize failed (${init.status})`)

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
    if (!r.ok) throw new Error(`agent_swarm: tools/call ${name} failed (${r.status})`)
    const body = await r.json()
    if (body.error) throw new Error(`agent_swarm: ${JSON.stringify(body.error)}`)
    const result = body.result
    if (result?.isError) throw new Error(`agent_swarm: ${result?.content?.[0]?.text ?? "tool error"}`)

    const sc = result?.structuredContent
    if (sc && typeof sc === "object") return sc as T
    const content = result?.content ?? []
    if (content.length === 0) return {} as T
    if (content.length === 1) {
      try {
        return JSON.parse(content[0].text)
      } catch {
        return content[0].text as T
      }
    }
    try {
      return JSON.parse(`[${content.map((c: any) => c.text).join(",")}]`) as T
    } catch {
      return content.map((c: any) => c.text).join("\n") as T
    }
  }

  // ---------------- 心跳保活 ----------------

  heartbeat(workspaceId: string, sessionId?: string) {
    return this.callTool("heartbeat", { workspace_id: workspaceId, session_id: sessionId ?? "" })
  }
}
