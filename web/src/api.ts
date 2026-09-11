/** agent_swarm 管理端 API 客户端 */

const BASE = import.meta.env.VITE_API_BASE ?? ""

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("swarm_token") ?? ""
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

async function request(path: string, options: RequestInit = {}) {
  const rsp = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers ?? {}) },
  })
  if (rsp.status === 401) {
    localStorage.removeItem("swarm_token")
    localStorage.removeItem("swarm_user")
    window.location.hash = "#/login"
    throw new Error("登录已过期，请重新登录")
  }
  const body = await rsp.json().catch(() => ({}))
  if (!rsp.ok) throw new Error(body.detail ?? `请求失败 (${rsp.status})`)
  return body
}

export interface User {
  id: string
  username: string
  created_at?: string
}

export interface Team {
  id: string
  name: string
  owner_id: string
  member_count: number
  created_at: string
}

export interface Workspace {
  id: string
  name: string
  path: string
  purpose: string
  capabilities: string | null
  notes: string | null
  status: "online" | "offline" | "disabled"
  owner: { id: string; username: string } | null
  team: { id: string; name: string } | null
  last_heartbeat: string | null
  created_at: string
}

export interface HelpRequest {
  id: string
  requester: { id: string; name: string; path: string } | null
  target: { id: string; name: string; path: string } | null
  question: string
  mode: string
  status: string
  result: string | null
  error: string | null
  created_at: string
}

export const api = {
  async register(username: string, password: string) {
    const rsp = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    const body = await rsp.json()
    if (!rsp.ok) throw new Error(body.detail ?? "注册失败")
    return body as { user: User; api_key: string; token: string }
  },

  async login(username: string, password: string) {
    const rsp = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    const body = await rsp.json()
    if (!rsp.ok) throw new Error(body.detail ?? "登录失败")
    return body as { token: string; user: User }
  },

  me: () => request("/api/me") as Promise<User & { api_key: string }>,

  resetApiKey: () => request("/api/me/apikey/reset", { method: "POST" }) as Promise<{ api_key: string }>,

  createTeam: (name: string) => request("/api/teams", { method: "POST", body: JSON.stringify({ name }) }),
  myTeams: () => request("/api/teams") as Promise<Team[]>,
  addMember: (teamId: string, username: string) =>
    request(`/api/teams/${teamId}/members`, { method: "POST", body: JSON.stringify({ username }) }),
  listMembers: (teamId: string) =>
    request(`/api/teams/${teamId}/members`) as Promise<Array<{ id: string; username: string; is_owner: boolean }>>,
  removeMember: (teamId: string, userId: string) =>
    request(`/api/teams/${teamId}/members/${userId}`, { method: "DELETE" }),

  workspaces: () => request("/api/workspaces") as Promise<Workspace[]>,
  disableWorkspace: (id: string) => request(`/api/workspaces/${id}/disable`, { method: "POST" }),
  enableWorkspace: (id: string) => request(`/api/workspaces/${id}/enable`, { method: "POST" }),
  deleteWorkspace: (id: string) => request(`/api/workspaces/${id}`, { method: "DELETE" }),

  helpRequests: () => request("/api/help-requests") as Promise<HelpRequest[]>,
}
