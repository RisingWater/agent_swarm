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
  monitor?: boolean
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

  calls: (workspaceId = "") =>
    request(`/api/calls${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""}`) as Promise<WorkspaceCall[]>,
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

  /** 中枢时间线向上滚动分页：before_id 之前最近一轮的事件 */
  fetchRounds: (workspaceId: string, beforeId: number) =>
    request(`/api/nexus/${workspaceId}/rounds?before_id=${beforeId}`) as Promise<{
      events: unknown[]
      first_id: number
      has_more: boolean
    }>,

  /** 聊天工具绑定（账号页）：绑定分组 + 每窗口的选中工作区/监控/简报设置 */
  chatBinds: () => request("/api/chat-binds") as Promise<ChatBindInfo>,

  /** 修改窗口设置（切换工作区/监控/简报），飞书端会收到通知 */
  updateChatBind: (chatId: string, patch: ChatBindPatch) =>
    request(`/api/chat-binds/${encodeURIComponent(chatId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }) as Promise<ChatBindChat>,

  /** 解绑飞书账号（清绑定与窗口工作区选择，飞书端会收到通知） */
  unbindChatAccount: (openId: string) =>
    request(`/api/chat-binds/${encodeURIComponent(openId)}`, { method: "DELETE" }) as Promise<{ ok: boolean }>,

  /** 微信 ClawBot：申请登录二维码 */
  weixinLoginStart: () =>
    request("/api/weixin/login/start", { method: "POST", body: "{}" }) as Promise<WeixinStatus>,

  /** 微信 ClawBot：登录流程状态（1.5s 轮询） */
  weixinLoginStatus: () => request("/api/weixin/login/status") as Promise<WeixinStatus>,

  /** 微信 ClawBot：提交数字配对码 */
  weixinLoginVerify: (code: string) =>
    request("/api/weixin/login/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    }) as Promise<{ ok: boolean }>,

  /** 微信 ClawBot：取消本次扫码 */
  weixinLoginCancel: () =>
    request("/api/weixin/login/cancel", { method: "POST", body: "{}" }) as Promise<{ ok: boolean }>,

  /** 微信 ClawBot：登录态概览 */
  weixinStatus: () => request("/api/weixin/status") as Promise<WeixinStatus>,

  /** 微信 ClawBot：断开登录 */
  weixinLogout: () =>
    request("/api/weixin/logout", { method: "POST", body: "{}" }) as Promise<{ ok: boolean }>,

  /** 微信 ClawBot：修改选中工作区/监控/简报 */
  weixinSettings: (patch: WeixinSettingsPatch) =>
    request("/api/weixin/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }) as Promise<WeixinStatus>,
}

/** 微信 ClawBot */
export interface WeixinFlow {
  status: "wait" | "scanned" | "need_verifycode" | "confirmed" | "error" | "expired"
  qrcode_img: string
  message: string
}

export interface WeixinStatus {
  flow: WeixinFlow | null
  logged_in: boolean
  wx_user_id?: string
  wx_bot_id?: string
  status?: string
  logged_at?: string | null
  workspace_id?: string
  monitor_on?: boolean
  brief_on?: boolean
}

export interface WeixinSettingsPatch {
  workspace_id?: string
  monitor_on?: boolean
  brief_on?: boolean
}

/** 聊天工具绑定 */
export interface ChatBindChat {
  chat_id: string
  chat_type: string
  workspace_id: string
  workspace_name: string
  monitor_on: boolean
  brief_on: boolean
}

export interface ChatBindGroup {
  open_id: string
  /** 飞书真实用户名（权限不可用/解析失败时为空，前端回退 open_id 前缀） */
  feishu_name: string
  bound_at: string | null
  chats: ChatBindChat[]
}

export interface ChatBindInfo {
  bindings: ChatBindGroup[]
  unbound_chats: ChatBindChat[]
}

export interface ChatBindPatch {
  workspace_id?: string
  monitor_on?: boolean
  brief_on?: boolean
}

// ────────────── 后台管理（独立登录） ──────────────

export interface AdminStats {
  users: number
  workspaces_total: number
  workspaces_online: number
  tasks_total: number
  daily_tasks: { date: string; count: number }[]
}

export interface AdminUser {
  id: string
  username: string
  created_at: string
  feishu_ids: string[]
}

export interface AdminWorkspace {
  id: string
  name: string
  path: string
  owner: string
  purpose: string
  agent_type: string
  online: boolean
  status: string
  session_id: string
  session_title: string
  calls_24h: number
}

export interface AdminCall {
  id: string
  monitor: boolean
  caller: string
  from_workspace: string
  target: string
  owner: string
  external_url: string
  instruction: string
  result: string
  error: string
  status: string
  created_at: string
  done_at: string | null
}

async function adminRequest(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem("swarm_admin_token") ?? ""
  const rsp = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
  })
  const body = await rsp.json().catch(() => ({}))
  if (rsp.status === 401) {
    localStorage.removeItem("swarm_admin_token")
    throw new Error(body.detail ?? "登录已过期，请重新登录")
  }
  if (!rsp.ok) throw new Error(body.detail ?? `请求失败 (${rsp.status})`)
  return body
}

export const adminApi = {
  async login(username: string, password: string) {
    const rsp = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    const body = await rsp.json()
    if (!rsp.ok) throw new Error(body.detail ?? "登录失败")
    localStorage.setItem("swarm_admin_token", body.token)
    return body as { token: string }
  },
  logout: () => localStorage.removeItem("swarm_admin_token"),
  stats: () => adminRequest("/api/admin/stats") as Promise<AdminStats>,
  users: () => adminRequest("/api/admin/users") as Promise<{ users: AdminUser[] }>,
  resetPassword: (userId: string) =>
    adminRequest(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: "POST",
      body: JSON.stringify({}),
    }) as Promise<{ ok: boolean; new_password: string }>,
  workspaces: () => adminRequest("/api/admin/workspaces") as Promise<{ workspaces: AdminWorkspace[] }>,
  calls: (workspaceId = "") =>
    adminRequest(`/api/admin/calls${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""}`) as Promise<{
      calls: AdminCall[]
    }>,
}
