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

export interface Workspace {
  id: string
  name: string
  path: string
  purpose: string
  capabilities: string | null
  notes: string | null
  status: "online" | "offline" | "disabled"
  agent_type: string | null
  owner: { id: string; username: string } | null
  last_heartbeat: string | null
  session_id: string | null
  session_title: string | null
  created_at: string
}

/** 安装命令用：当前页面 origin（vite dev 时代理到后端，生产同域） */
export const pageOrigin = window.location.origin

/** A2A 任务（调用记录页 / a2a_call 历史） */
export interface WorkspaceCall {
  id: string
  caller: { id: string; name: string; path: string } | null
  target: { id: string; name: string; path: string } | null
  external_url?: string | null
  instruction: string
  status: string
  result: string | null
  error: string | null
  created_at: string
  done_at: string | null
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

  changePassword: (oldPassword: string, newPassword: string) =>
    request("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }) as Promise<{ ok: boolean }>,

  resetApiKey: () => request("/api/me/apikey/reset", { method: "POST" }) as Promise<{ api_key: string }>,

  workspaces: () => request("/api/workspaces") as Promise<Workspace[]>,
  disableWorkspace: (id: string) => request(`/api/workspaces/${id}/disable`, { method: "POST" }),
  enableWorkspace: (id: string) => request(`/api/workspaces/${id}/enable`, { method: "POST" }),
  deleteWorkspace: (id: string) => request(`/api/workspaces/${id}`, { method: "DELETE" }),

  calls: () => request("/api/calls") as Promise<WorkspaceCall[]>,
  deleteCall: (id: string) => request(`/api/calls/${id}`, { method: "DELETE" }),

  /** web 中枢：以用户身份向工作区下发 A2A 任务（非流式下发，事件走 /ws/nexus 订阅） */
  sendTask: (workspaceId: string, text: string, taskId: string = "") =>
    request(`/api/nexus/${workspaceId}/message:send`, {
      method: "POST",
      body: JSON.stringify({ text, task_id: taskId }),
    }) as Promise<{ task_id: string; context_id: string; status: string }>,

  /** web 中枢：应答 input-required 任务（权限/提问），走 A2A message/send 续聊 */
  replyTask: (workspaceId: string, taskId: string, payload: Record<string, unknown>) =>
    request(`/api/nexus/${workspaceId}/reply`, {
      method: "POST",
      body: JSON.stringify({ task_id: taskId, ...payload }),
    }) as Promise<{ ok: boolean; status: string }>,

  /** 清空工作区任务历史（事件+任务记录） */
  clearWorkspaceHistory: (workspaceId: string) =>
    request(`/api/nexus/${workspaceId}/history`, { method: "DELETE" }) as Promise<{ ok: boolean }>,
}
