/** 后台管理（#/admin，独立登录）：面板统计折线图 / 用户管理 / 工作区全量。 */
import { useCallback, useEffect, useState } from "react"
import { adminApi, type AdminStats, type AdminUser, type AdminWorkspace, type AdminCall } from "./api"
import { copyText } from "./copy"
import { Btn, Modal, NexusWorkspaceSelect, SearchBox } from "./App"

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

/** 大小写不敏感子串匹配 */
function hit(haystack: unknown, q: string): boolean {
  return String(haystack ?? "").toLowerCase().includes(q.trim().toLowerCase())
}

function statusBadge(s: string) {
  if (s === "completed") return <span>✅ 完成</span>
  if (s === "failed") return <span>❌ 失败</span>
  if (s === "canceled") return <span>🚫 取消</span>
  if (s === "input-required") return <span>⏸ 待输入</span>
  if (s === "working") return <span>🔄 执行中</span>
  return <span>⏳ 排队</span>
}

/** 近 30 天指令折线（内联 SVG，零依赖） */
function DailyChart({ data }: { data: { date: string; count: number }[] }) {
  const w = 720
  const h = 200
  const pad = { l: 36, r: 12, t: 14, b: 26 }
  const max = Math.max(1, ...data.map((d) => d.count))
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  const n = data.length
  const px = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw)
  const py = (v: number) => pad.t + ih - (v / max) * ih
  const line = data.map((d, i) => `${px(i)},${py(d.count)}`).join(" ")
  const area = `${pad.l},${pad.t + ih} ${line} ${pad.l + iw},${pad.t + ih}`
  const gridYs = [0, 0.5, 1].map((f) => pad.t + ih - f * ih)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {gridYs.map((y, i) => (
        <g key={i}>
          <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke="var(--border)" strokeWidth="1" />
          <text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--text-weak)">
            {Math.round(max * (i * 0.5))}
          </text>
        </g>
      ))}
      <polygon points={area} fill="var(--accent, #4a7dff)" opacity="0.12" />
      <polyline points={line} fill="none" stroke="var(--accent, #4a7dff)" strokeWidth="2" />
      {data.map((d, i) => (
        <circle key={d.date} cx={px(i)} cy={py(d.count)} r="2.5" fill="var(--accent, #4a7dff)">
          <title>{`${d.date}: ${d.count}`}</title>
        </circle>
      ))}
      {data.map((d, i) =>
        i % 5 === 0 || i === n - 1 ? (
          <text key={d.date} x={px(i)} y={h - 8} textAnchor="middle" fontSize="10" fill="var(--text-weak)">
            {d.date.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  )
}

function AdminLogin({ toast, onSuccess }: { toast: (m: string) => void; onSuccess: () => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (!username || !password) return toast("请填写完整")
    setLoading(true)
    try {
      await adminApi.login(username, password)
      onSuccess()
    } catch (e: any) {
      toast(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="admin-login-page">
      <div className="admin-login-card" style={{ maxWidth: 360 }}>
        <Logo size={30} />
        <h2 style={{ margin: "10px 0 4px" }}>后台管理</h2>
        <p style={{ color: "var(--text-weak)", fontSize: 13, margin: "0 0 18px" }}>
          agent_swarm 管理控制台（独立登录）
        </p>
        <input
          className=""
          placeholder="管理员用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <input
          className=""
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn btn-primary" disabled={loading} onClick={submit} style={{ width: "100%" }}>
          {loading ? "登录中…" : "登录"}
        </button>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="home-card" style={{ padding: "16px 20px" }}>
      <p className="section-label" style={{ marginBottom: 6 }}>[ {label} ]</p>
      <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
      {sub && <p style={{ color: "var(--text-weak)", fontSize: 12, margin: "6px 0 0" }}>{sub}</p>}
    </div>
  )
}

function PanelPage({ toast, onLogout }: { toast: (m: string) => void; onLogout: () => void }) {
  const [tab, setTab] = useState<"stats" | "users" | "workspaces" | "calls">("stats")
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([])
  const [calls, setCalls] = useState<AdminCall[]>([])
  const [callWs, setCallWs] = useState("")
  const [resetPwd, setResetPwd] = useState<{ user: string; password: string } | null>(null)
  const [userQuery, setUserQuery] = useState("")
  const [wsQuery, setWsQuery] = useState("")
  const [callQuery, setCallQuery] = useState("")

  const refresh = useCallback(() => {
    adminApi.stats().then(setStats).catch((e) => toast(e.message))
    adminApi.users().then((r) => setUsers(r.users)).catch((e) => toast(e.message))
    adminApi.workspaces().then((r) => setWorkspaces(r.workspaces)).catch((e) => toast(e.message))
  }, [toast])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (tab === "calls") {
      adminApi.calls(callWs).then((r) => setCalls(r.calls)).catch((e) => toast(e.message))
    }
  }, [tab, callWs, toast])

  const doReset = async (u: AdminUser) => {
    try {
      const r = await adminApi.resetPassword(u.id)
      setResetPwd({ user: u.username, password: r.new_password })
    } catch (e: any) {
      toast(e.message)
    }
  }

  return (
    <>
      <header className="topnav">
        <a className="topnav-logo" href="#/admin" onClick={(e) => e.preventDefault()} title="后台管理">
          <Logo />
          <b style={{ fontSize: 14 }}>后台管理</b>
        </a>
        <nav className="topnav-links">
          <a className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>面板</a>
          <a className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>用户</a>
          <a className={tab === "workspaces" ? "active" : ""} onClick={() => setTab("workspaces")}>工作区</a>
          <a className={tab === "calls" ? "active" : ""} onClick={() => setTab("calls")}>调用记录</a>
          <a style={{ color: "var(--text-weak)" }}
            onClick={() => { adminApi.logout(); onLogout() }}>退出登录</a>
        </nav>
      </header>
      <main className="page">
        {tab === "stats" && (
          <>
            <p className="section-label">[ 面板 ]</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 22 }}>
              <StatCard label="用户" value={stats?.users ?? "…"} />
              <StatCard label="在线工作区" value={stats?.workspaces_online ?? "…"}
                sub={`共 ${stats?.workspaces_total ?? 0} 个`} />
              <StatCard label="指令总数" value={stats?.tasks_total ?? "…"} />
            </div>
            <p className="section-label">[ 近 30 天每日指令 ]</p>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, background: "var(--bg)" }}>
              {stats ? <DailyChart data={stats.daily_tasks} /> : <p>loading…</p>}
            </div>
          </>
        )}
        {tab === "users" && (
          <>
            <p className="section-label">[ 用户 ]</p>
            <SearchBox value={userQuery} onChange={setUserQuery} placeholder="搜索用户名 / 飞书 ID…" />
            <table className="admin-table">
              <thead><tr><th>用户名</th><th>创建时间</th><th>绑定飞书 ID</th><th></th></tr></thead>
              <tbody>
                {users.filter((u) =>
                  hit(u.username, userQuery) || u.feishu_ids.some((f) => hit(f, userQuery)),
                ).map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.username}</b></td>
                    <td>{fmtDate(u.created_at)}</td>
                    <td style={{ maxWidth: 260 }}>
                      {u.feishu_ids.length
                        ? u.feishu_ids.map((f) => (
                          <span key={f} title={f} style={{ marginRight: 8, fontSize: 12 }}>
                            {f.slice(0, 14)}…
                          </span>
                        ))
                        : <span style={{ color: "var(--text-weak)" }}>—</span>}
                    </td>
                    <td><Btn size="sm" onClick={() => doReset(u)}>重置密码</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === "workspaces" && (
          <>
            <p className="section-label">[ 工作区 ]</p>
            <SearchBox value={wsQuery} onChange={setWsQuery} placeholder="搜索 ID / 名字 / 归属用户 / 用途 / 会话…" />
            <table className="admin-table">
              <thead>
                <tr><th>ID</th><th>名字</th><th>归属用户</th><th>用途</th><th>会话</th><th>状态</th><th>24h 调用</th></tr>
              </thead>
              <tbody>
                {workspaces.filter((w) =>
                  hit(w.id, wsQuery) || hit(w.name, wsQuery) || hit(w.owner, wsQuery)
                  || hit(w.purpose, wsQuery) || hit(w.session_title, wsQuery) || hit(w.agent_type, wsQuery),
                ).map((w) => (
                  <tr key={w.id}>
                    <td title={w.id} style={{ fontSize: 12 }}>{w.id.slice(0, 10)}…</td>
                    <td><b>{w.name}</b>{w.agent_type ? <span style={{ color: "var(--text-weak)", fontSize: 12 }}> · {w.agent_type}</span> : null}</td>
                    <td>{w.owner}</td>
                    <td style={{ maxWidth: 260, fontSize: 12 }} title={w.purpose}>
                      {w.purpose ? (w.purpose.length > 60 ? w.purpose.slice(0, 60) + "…" : w.purpose) : "—"}
                    </td>
                    <td style={{ maxWidth: 180, fontSize: 12 }}>
                      {w.online && w.session_title
                        ? w.session_title.slice(0, 24) + (w.session_title.length > 24 ? "…" : "")
                        : "—"}
                    </td>
                    <td>{w.status === "disabled" ? <span>🚫 禁用</span> : w.online ? <span>🟢 在线</span> : <span>⚪ 离线</span>}</td>
                    <td>{w.calls_24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === "calls" && (
          <>
            <p className="section-label">[ 调用记录 ]</p>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <NexusWorkspaceSelect
                list={workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path, agent_type: w.agent_type, owner: w.owner }))}
                value={callWs}
                onChange={setCallWs}
                showOwner
              />
              {callWs && <Btn size="sm" onClick={() => setCallWs("")}>全部工作区</Btn>}
              <SearchBox value={callQuery} onChange={setCallQuery} placeholder="搜索 ID / 目标 / 发起方 / 内容…" />
              <span style={{ color: "var(--text-weak)", fontSize: 12 }}>
                最近 500 条 · 开启落库加密后内容列仅显示占位（管理员不持有用户密钥）
              </span>
            </div>
            <table className="admin-table">
              <thead>
                <tr><th>ID</th><th>发起方</th><th>目标</th><th>归属</th><th>指令</th><th>结果</th><th>状态</th><th>时间</th></tr>
              </thead>
              <tbody>
                {calls.filter((c) =>
                  hit(c.id, callQuery) || hit(c.target, callQuery) || hit(c.from_workspace, callQuery)
                  || hit(c.caller, callQuery) || hit(c.owner, callQuery)
                  || (c.instruction !== "[加密内容]" && hit(c.instruction, callQuery)),
                ).map((c) => (
                  <tr key={c.id}>
                    <td title={c.id} style={{ fontSize: 12 }}>{c.id.slice(0, 10)}…</td>
                    <td style={{ fontSize: 12 }}>
                      {c.monitor ? <span title="前台监控轮">👀 {c.from_workspace || c.target} (monitor)</span>
                        : c.from_workspace || (c.external_url ? `🔗 ${c.external_url.slice(0, 28)}…` : c.caller || "—")}
                    </td>
                    <td style={{ fontSize: 12 }}>{c.target || (c.external_url ? "🔗 外部" : "—")}</td>
                    <td style={{ fontSize: 12 }}>{c.owner || "—"}</td>
                    <td style={{ maxWidth: 220, fontSize: 12 }} title={c.instruction}>
                      {c.instruction ? (c.instruction.length > 40 ? c.instruction.slice(0, 40) + "…" : c.instruction) : "—"}
                    </td>
                    <td style={{ maxWidth: 220, fontSize: 12 }} title={c.error || c.result}>
                      {c.error
                        ? <span style={{ color: "var(--danger, #c0392b)" }}>{c.error.slice(0, 40)}{c.error.length > 40 ? "…" : ""}</span>
                        : c.result
                          ? (c.result.length > 40 ? c.result.slice(0, 40) + "…" : c.result)
                          : "—"}
                    </td>
                    <td style={{ fontSize: 12 }}>{statusBadge(c.status)}</td>
                    <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{fmtDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {resetPwd && (
          <Modal onClose={() => setResetPwd(null)} title="密码已重置">
            <p style={{ fontSize: 13 }}>
              用户 <b>{resetPwd.user}</b> 的新密码：
            </p>
            <div className="keyrow">
              <div className="keybox" style={{ userSelect: "all" }}>{resetPwd.password}</div>
              <Btn variant="icon" title="copy" onClick={async () => {
                toast(await copyText(resetPwd.password) ? "已复制" : "复制失败")
              }}>⧉</Btn>
            </div>
            <p style={{ color: "var(--text-weak)", fontSize: 12, marginTop: 10 }}>
              只展示这一次，请立即转告用户。API Key 不受影响（agent 连接不断开）。
            </p>
          </Modal>
        )}
      </main>
    </>
  )
}

export function AdminPage({ toast }: { toast: (m: string) => void }) {
  const [logged, setLogged] = useState(!!localStorage.getItem("swarm_admin_token"))
  if (!logged) {
    return (
      <AdminLogin
        toast={toast}
        onSuccess={() => setLogged(true)}
      />
    )
  }
  return <PanelPage toast={toast} onLogout={() => setLogged(false)} />
}

function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="5.5" r="2.5" />
      <circle cx="5.5" cy="17" r="2.5" />
      <circle cx="18.5" cy="17" r="2.5" />
      <path d="M10.5 8 7 14.5M13.5 8l3.5 6.5M8 17h8" />
    </svg>
  )
}
