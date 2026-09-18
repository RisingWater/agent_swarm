/** 后台管理（#/admin，独立登录）：面板统计折线图 / 用户管理 / 工作区全量。 */
import { useCallback, useEffect, useState } from "react"
import { adminApi, type AdminStats, type AdminUser, type AdminWorkspace } from "./api"
import { copyText } from "./copy"
import { Btn, Modal } from "./App"

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
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
  const [tab, setTab] = useState<"stats" | "users" | "workspaces">("stats")
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([])
  const [resetPwd, setResetPwd] = useState<{ user: string; password: string } | null>(null)

  const refresh = useCallback(() => {
    adminApi.stats().then(setStats).catch((e) => toast(e.message))
    adminApi.users().then((r) => setUsers(r.users)).catch((e) => toast(e.message))
    adminApi.workspaces().then((r) => setWorkspaces(r.workspaces)).catch((e) => toast(e.message))
  }, [toast])
  useEffect(() => { refresh() }, [refresh])

  const doReset = async (u: AdminUser) => {
    try {
      const r = await adminApi.resetPassword(u.id)
      setResetPwd({ user: u.username, password: r.new_password })
    } catch (e: any) {
      toast(e.message)
    }
  }

  return (
    <div className="subpage">
      <aside className="subpage-toc">
        <p className="section-label">[ 后台管理 ]</p>
        <a className={`subpage-item${tab === "stats" ? " active" : ""}`} onClick={() => setTab("stats")}>面板</a>
        <a className={`subpage-item${tab === "users" ? " active" : ""}`} onClick={() => setTab("users")}>用户</a>
        <a className={`subpage-item${tab === "workspaces" ? " active" : ""}`} onClick={() => setTab("workspaces")}>工作区</a>
        <a className="subpage-item" style={{ marginTop: 20, color: "var(--text-weak)" }}
          onClick={() => { adminApi.logout(); onLogout() }}>退出登录</a>
      </aside>
      <div className="subpage-body">
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
            <table className="admin-table">
              <thead><tr><th>用户名</th><th>创建时间</th><th>绑定飞书 ID</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
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
            <table className="admin-table">
              <thead>
                <tr><th>ID</th><th>名字</th><th>归属用户</th><th>用途</th><th>会话</th><th>状态</th><th>24h 调用</th></tr>
              </thead>
              <tbody>
                {workspaces.map((w) => (
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
      </div>
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
    </div>
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
