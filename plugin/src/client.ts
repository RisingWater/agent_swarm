/** agent_swarm 服务端 API 客户端（MCP JSON-RPC over HTTP + 管理 REST） */

export interface SwarmConfig {
  serverUrl: string
  apiKey: string
  teamName?: string
  heartbeatIntervalMs?: number
  pollIntervalMs?: number
}

export interface HelpTask {
  request_id: string
  mode: "foreground" | "background"
  session_id?: string | null
  question: string
  requester?: {
    workspace_id: string
    name: string
    path: string
    purpose: string
  } | null
}

export interface WorkspaceInfo {
  workspace_id: string
  name: string
  path: string
  purpose: string
  capabilities: string | null
  notes: string | null
  status: string
  owner: string
  is_self: boolean
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
          clientInfo: { name: "opencode-agent-swarm", version: "0.1.0" },
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

    // 优先 structuredContent：服务端 dict 包装 {"workspaces": [...]} / {"requests": [...]} 等
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
    // 多 content block（兼容服务端未包裹的 list 返回）
    try {
      return JSON.parse(`[${content.map((c: any) => c.text).join(",")}]`) as T
    } catch {
      return content.map((c: any) => c.text).join("\n") as T
    }
  }

  // ---------------- 工具封装 ----------------

  registerWorkspace(p: {
    path: string
    purpose?: string
    capabilities?: string
    teamName?: string
  }): Promise<{
    workspace_id: string
    created: boolean
    need_summary: boolean
    purpose?: string
    capabilities?: string
    name: string
    status: string
  }> {
    return this.callTool("register_workspace", {
      path: p.path,
      purpose: p.purpose ?? "",
      capabilities: p.capabilities ?? "",
      team_name: p.teamName ?? "",
    })
  }

  heartbeat(workspaceId: string, sessionId?: string) {
    return this.callTool("heartbeat", { workspace_id: workspaceId, session_id: sessionId ?? "" })
  }

  updateNotes(workspaceId: string, notes: string, append = true) {
    return this.callTool("update_notes", { workspace_id: workspaceId, notes, append })
  }

  updateInfo(workspaceId: string, purpose?: string, capabilities?: string) {
    return this.callTool("update_info", {
      workspace_id: workspaceId,
      purpose: purpose ?? "",
      capabilities: capabilities ?? "",
    })
  }

  listWorkspaces(): Promise<{ workspaces: WorkspaceInfo[] }> {
    return this.callTool("list_workspaces", {})
  }

  requestHelp(p: {
    requesterWorkspaceId: string
    targetWorkspaceId: string
    question: string
    mode?: "foreground" | "background"
    sessionId?: string
  }): Promise<{ request_id: string; status: string }> {
    return this.callTool("request_help", {
      requester_workspace_id: p.requesterWorkspaceId,
      target_workspace_id: p.targetWorkspaceId,
      question: p.question,
      mode: p.mode ?? "background",
      session_id: p.sessionId ?? "",
    })
  }

  getHelpResult(requestId: string): Promise<{ status: string; result?: string; error?: string }> {
    return this.callTool("get_help_result", { request_id: requestId })
  }

  pollHelpRequests(workspaceId: string): Promise<{ requests: HelpTask[] }> {
    return this.callTool("poll_help_requests", { workspace_id: workspaceId })
  }

  submitHelpResult(requestId: string, ok: boolean, result: string) {
    return this.callTool("submit_help_result", { request_id: requestId, ok, result })
  }
}
