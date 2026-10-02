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
  /** 工作区角色：agent（普通）/ planner（规划器） */
  role: string
  owner: { id: string; username: string } | null
  last_heartbeat: string | null
  session_id: string | null
  session_title: string | null
  created_at: string
}

/** 安装命令用：当前页面 origin（vite dev 时代理到后端，生产同域） */
export const pageOrigin = window.location.origin

/** 团队共享给我的工作区（只读：不能启用/禁用/删除/再共享） */
export interface SharedWorkspace {
  id: string
  name: string
  purpose: string
  capabilities: string | null
  agent_type: string | null
  status: "online" | "offline" | "disabled"
  role?: string
  owner: { id: string; username: string } | null
  teams: string[]
  last_heartbeat: string | null
}

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

// ────────────── 团队 ──────────────

export interface TeamSummary {
  id: string
  name: string
  join_policy: "approval" | "open" | "closed"
  description: string
  leader: { id: string; username: string }
  is_leader: boolean
  member_count: number
  pending_count: number
  workspace_count: number
  created_at: string
}

export interface TeamMemberInfo {
  user_id: string
  username: string
  status: "pending" | "active"
  kind: "invite" | "request"
  initiated_by: string
  created_at: string | null
}

export interface TeamDetail extends TeamSummary {
  members: TeamMemberInfo[]
  workspaces: { workspace_id: string; name: string; owner?: string; shared_by: string }[]
}

export interface TeamInvitations {
  invites: { team: { id: string; name: string }; invited_by: { id: string; username: string }; created_at: string | null }[]
  requests: { team: { id: string; name: string }; user: { id: string; username: string }; created_at: string | null }[]
}

export interface DiscoveredTeam {
  id: string
  name: string
  join_policy: "approval" | "open" | "closed"
  description: string
  leader: { id: string; username: string }
  member_count: number
}

// ────────────── 规划器（planner-core 推回的目标 + 任务树快照） ──────────────

export interface PlannerGoal {
  id: string
  title: string
  description?: string
  status?: string
  /** 拆解审批状态：draft（已拆解待审批）/ approved（已通过）。缺失按 draft 处理 */
  plan_status?: string
  /** 专家工作区（有专家时任务树由专家拆解、含专家验收点） */
  expert_workspace_id?: string
  expert_name?: string
  /** 优先级：高=2 / 中=1 / 低=0（core 约定） */
  priority?: number | string
  deadline?: string
  success_criteria?: string
  /** 成功标准是否经专家确认：1=已确认 / 0=待确认 */
  criteria_confirmed?: number
  progress?: { done: number; total: number }
}

export interface PlannerTask {
  id: string
  goal_id?: string
  title: string
  /** 任务描述（core 如有推送则展示） */
  description?: string
  status?: string
  depends_on?: string[]
  /** 建议执行 agent（core 如有推送则展示） */
  suggested_agent?: string
  /** 实际执行 agent */
  assigned_agent?: string
  acceptance_type?: string
  acceptance_result?: string
  updated_at?: string
}

export interface PlannerState {
  workspace_id: string
  online: boolean
  updated_at: string | null
  goals: PlannerGoal[]
  tasks: PlannerTask[]
}

export interface PlannerOp {
  op_id: string
  op: string
  payload: Record<string, unknown>
  ok: boolean | null
  error: string
  created_at: string
  done_at: string | null
}

export interface Artifact {
  id: string
  name: string
  size: number
  mime: string
  note: string
  task_id: string
  workspace_id: string
  workspace_name?: string
  owner?: string
  shared?: boolean
  pinned: boolean
  created_at: string
  expires_at: string
  remain_days: number
  download_url: string
}

/** 站内信 */
export interface Notification {
  id: string
  kind: string
  title: string
  body: string
  team_id: string
  team_name: string
  actor: { id: string; username: string } | null
  read: boolean
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

  changePassword: (oldPassword: string, newPassword: string) =>
    request("/api/me/password", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }) as Promise<{ ok: boolean }>,

  resetApiKey: () => request("/api/me/apikey/reset", { method: "POST" }) as Promise<{ api_key: string }>,

  workspaces: () => request("/api/workspaces") as Promise<Workspace[]>,
  sharedWorkspaces: () => request("/api/workspaces/shared") as Promise<{ workspaces: SharedWorkspace[] }>,
  disableWorkspace: (id: string) => request(`/api/workspaces/${id}/disable`, { method: "POST" }),
  enableWorkspace: (id: string) => request(`/api/workspaces/${id}/enable`, { method: "POST" }),
  deleteWorkspace: (id: string) => request(`/api/workspaces/${id}`, { method: "DELETE" }),
  /** 设置工作区角色（agent / planner），仅属主 */
  setWorkspaceRole: (id: string, role: string) =>
    request(`/api/workspaces/${encodeURIComponent(id)}/role`, {
      method: "POST", body: JSON.stringify({ role }),
    }) as Promise<{ ok: boolean; role: string }>,

  calls: (workspaceId = "") =>
    request(`/api/calls${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""}`) as Promise<WorkspaceCall[]>,
  deleteCall: (id: string) => request(`/api/calls/${id}`, { method: "DELETE" }),

  // 团队
  teams: () => request("/api/teams") as Promise<{ teams: TeamSummary[] }>,
  createTeam: (body: { name: string; join_policy?: string; description?: string }) =>
    request("/api/teams", { method: "POST", body: JSON.stringify(body) }) as Promise<TeamSummary>,
  teamDetail: (id: string) => request(`/api/teams/${encodeURIComponent(id)}`) as Promise<TeamDetail>,
  updateTeam: (id: string, patch: { name?: string; join_policy?: string; description?: string }) =>
    request(`/api/teams/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }) as Promise<TeamSummary>,
  deleteTeam: (id: string) => request(`/api/teams/${encodeURIComponent(id)}`, { method: "DELETE" }),
  discoverTeams: (q = "") =>
    request(`/api/teams/discover?q=${encodeURIComponent(q)}`) as Promise<{ teams: DiscoveredTeam[] }>,
  teamInvitations: () => request("/api/teams/invitations") as Promise<TeamInvitations>,
  inviteMember: (id: string, username: string) =>
    request(`/api/teams/${encodeURIComponent(id)}/members/invite`, {
      method: "POST", body: JSON.stringify({ username }),
    }) as Promise<{ ok: boolean }>,
  joinTeam: (id: string) =>
    request(`/api/teams/${encodeURIComponent(id)}/join`, { method: "POST", body: "{}" }) as Promise<{ ok: boolean; status: string }>,
  decideMembership: (id: string, userId: string, action: "accept" | "reject") =>
    request(`/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/decision`, {
      method: "POST", body: JSON.stringify({ action }),
    }) as Promise<{ ok: boolean }>,
  removeMember: (id: string, userId: string) =>
    request(`/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }) as Promise<{ ok: boolean }>,
  leaveTeam: (id: string) =>
    request(`/api/teams/${encodeURIComponent(id)}/leave`, { method: "POST", body: "{}" }) as Promise<{ ok: boolean }>,
  transferLeadership: (id: string, userId: string) =>
    request(`/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/transfer`, {
      method: "POST", body: "{}",
    }) as Promise<{ ok: boolean }>,

  // 工作区共享（调用权）
  workspaceShares: (id: string) =>
    request(`/api/workspaces/${encodeURIComponent(id)}/shares`) as Promise<{ teams: { team_id: string; name: string }[] }>,
  setWorkspaceShares: (id: string, teamIds: string[]) =>
    request(`/api/workspaces/${encodeURIComponent(id)}/shares`, {
      method: "PUT", body: JSON.stringify({ team_ids: teamIds }),
    }) as Promise<{ ok: boolean; team_ids: string[] }>,

  // 规划器控制通道（planner-core 经 /ws/planner 推快照；操作经 REST 下发）
  plannerState: (workspaceId: string) =>
    request(`/api/planner/${encodeURIComponent(workspaceId)}/state`) as Promise<PlannerState>,
  plannerOp: (workspaceId: string, op: string, payload: Record<string, unknown> = {}) =>
    request(`/api/planner/${encodeURIComponent(workspaceId)}/op`, {
      method: "POST", body: JSON.stringify({ op, payload }),
    }) as Promise<{ op_id: string; op: string }>,
  plannerOps: (workspaceId: string) =>
    request(`/api/planner/${encodeURIComponent(workspaceId)}/ops`) as Promise<{ ops: PlannerOp[] }>,

  artifacts: () => request("/api/artifacts") as Promise<Artifact[]>,
  pinArtifact: (id: string, pinned: boolean) =>
    request(`/api/artifacts/${id}/pin`, { method: "PUT", body: JSON.stringify({ pinned }) }) as Promise<Artifact>,
  deleteArtifact: (id: string) => request(`/api/artifacts/${id}`, { method: "DELETE" }) as Promise<{ ok: boolean }>,

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

  // 站内信
  notifications: (unreadOnly = false) =>
    request(`/api/notifications${unreadOnly ? "?unread_only=true" : ""}`) as Promise<{ notifications: Notification[] }>,
  notificationUnreadCount: () => request("/api/notifications/unread_count") as Promise<{ count: number }>,
  markNotificationRead: (id: string) =>
    request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" }) as Promise<{ ok: boolean }>,
  markAllNotificationsRead: () =>
    request("/api/notifications/read_all", { method: "POST", body: "{}" }) as Promise<{ ok: boolean; count: number }>,
  deleteNotification: (id: string) =>
    request(`/api/notifications/${encodeURIComponent(id)}`, { method: "DELETE" }) as Promise<{ ok: boolean }>,
  deleteAllNotifications: () =>
    request("/api/notifications", { method: "DELETE" }) as Promise<{ ok: boolean; count: number }>,

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
  workspace_name?: string
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
