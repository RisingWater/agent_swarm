/** 后台管理（#/admin，独立登录）：面板统计折线图 / 用户管理 / 工作区全量。 */
import { useCallback, useEffect, useState } from "react"
import { adminApi, type AdminStats, type AdminUser, type AdminWorkspace, type AdminCall } from "./api"
import { copyText } from "./copy"
import { Btn, Modal, NexusWorkspaceSelect, SearchBox } from "./App"
import { useI18n, type Lang } from "./i18n"

/** 顶栏中英文切换（与主站 `.lang-switch` 视效一致；AdminPage 也在 LangProvider 内渲染）。 */
function LangSwitch() {
  const { lang, setLang } = useI18n()
  const pick = (l: Lang) => () => setLang(l)
  return (
    <span className="lang-switch" role="group" aria-label="Language / 语言">
      <button type="button" className={lang === "zh" ? "on" : ""} aria-pressed={lang === "zh"}
        title="中文" onClick={pick("zh")}>中</button>
      <button type="button" className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"}
        title="English" onClick={pick("en")}>EN</button>
    </span>
  )
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}

/** 大小写不敏感子串匹配 */
function hit(haystack: unknown, q: string): boolean {
  return String(haystack ?? "").toLowerCase().includes(q.trim().toLowerCase())
}

function statusBadge(s: string, t: (zh: string, en: string) => string) {
  if (s === "completed") return <span>✅ {t("完成", "completed")}</span>
  if (s === "failed") return <span>❌ {t("失败", "failed")}</span>
  if (s === "canceled") return <span>🚫 {t("取消", "canceled")}</span>
  if (s === "input-required") return <span>⏸ {t("待输入", "input-required")}</span>
  if (s === "working") return <span>🔄 {t("执行中", "working")}</span>
  return <span>⏳ {t("排队", "queued")}</span>
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
  const { t } = useI18n()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (!username || !password) return toast(t("请填写完整", "Please fill in all fields"))
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
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}><LangSwitch /></div>
        <Logo size={30} />
        <h2 style={{ margin: "10px 0 4px" }}>{t("后台管理", "Admin")}</h2>
        <p style={{ color: "var(--text-weak)", fontSize: 13, margin: "0 0 18px" }}>
          {t("agent_swarm 管理控制台（独立登录）", "agent_swarm admin console (separate login)")}
        </p>
        <input
          className=""
          placeholder={t("管理员用户名", "Admin username")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <input
          className=""
          type="password"
          placeholder={t("密码", "Password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn btn-primary" disabled={loading} onClick={submit} style={{ width: "100%" }}>
          {loading ? t("登录中…", "Logging in…") : t("登录", "Log in")}
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
  const { t } = useI18n()
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
        <a className="topnav-logo" href="#/admin" onClick={(e) => e.preventDefault()} title={t("后台管理", "Admin")}>
          <Logo />
          <b style={{ fontSize: 14 }}>{t("后台管理", "Admin")}</b>
        </a>
        <nav className="topnav-links">
          <a className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>{t("面板", "Dashboard")}</a>
          <a className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>{t("用户", "Users")}</a>
          <a className={tab === "workspaces" ? "active" : ""} onClick={() => setTab("workspaces")}>{t("工作区", "Workspaces")}</a>
          <a className={tab === "calls" ? "active" : ""} onClick={() => setTab("calls")}>{t("调用记录", "Calls")}</a>
          <LangSwitch />
          <a style={{ color: "var(--text-weak)" }}
            onClick={() => { adminApi.logout(); onLogout() }}>{t("退出登录", "Log out")}</a>
        </nav>
      </header>
      <main className="page">
        {tab === "stats" && (
          <>
            <p className="section-label">{t("[ 面板 ]", "[ Dashboard ]")}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 22 }}>
              <StatCard label={t("用户", "Users")} value={stats?.users ?? "…"} />
              <StatCard label={t("在线工作区", "Online workspaces")} value={stats?.workspaces_online ?? "…"}
                sub={t(`共 ${stats?.workspaces_total ?? 0} 个`, `${stats?.workspaces_total ?? 0} total`)} />
              <StatCard label={t("指令总数", "Total tasks")} value={stats?.tasks_total ?? "…"} />
            </div>
            <p className="section-label">{t("[ 近 30 天每日指令 ]", "[ Tasks per day, last 30 days ]")}</p>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, background: "var(--bg)" }}>
              {stats ? <DailyChart data={stats.daily_tasks} /> : <p>{t("加载中…", "loading…")}</p>}
            </div>
          </>
        )}
        {tab === "users" && (
          <>
            <p className="section-label">{t("[ 用户 ]", "[ Users ]")}</p>
            <div className="admin-toolbar">
              <SearchBox value={userQuery} onChange={setUserQuery} placeholder={t("搜索用户名 / 飞书 ID…", "Search username / Feishu ID…")} />
            </div>
            <table className="admin-table">
              <thead><tr><th>{t("用户名", "Username")}</th><th>{t("创建时间", "Created")}</th><th>{t("绑定飞书 ID", "Bound Feishu ID")}</th><th></th></tr></thead>
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
                    <td><Btn size="sm" onClick={() => doReset(u)}>{t("重置密码", "Reset password")}</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === "workspaces" && (
          <>
            <p className="section-label">{t("[ 工作区 ]", "[ Workspaces ]")}</p>
            <div className="admin-toolbar">
              <SearchBox value={wsQuery} onChange={setWsQuery} placeholder={t("搜索 ID / 名字 / 归属用户 / 用途 / 会话…", "Search ID / name / owner / purpose / session…")} />
            </div>
            <table className="admin-table">
              <thead>
                <tr><th>ID</th><th>{t("名字", "Name")}</th><th>{t("归属用户", "Owner")}</th><th>{t("用途", "Purpose")}</th><th>{t("会话", "Session")}</th><th>{t("状态", "Status")}</th><th>{t("24h 调用", "Calls (24h)")}</th></tr>
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
                    <td>{w.status === "disabled" ? <span>🚫 {t("禁用", "disabled")}</span> : w.online ? <span>🟢 {t("在线", "online")}</span> : <span>⚪ {t("离线", "offline")}</span>}</td>
                    <td>{w.calls_24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab === "calls" && (
          <>
            <p className="section-label">{t("[ 调用记录 ]", "[ Calls ]")}</p>
            <div className="admin-toolbar">
              <NexusWorkspaceSelect
                list={workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path, agent_type: w.agent_type, owner: w.owner }))}
                value={callWs}
                onChange={setCallWs}
                showOwner
              />
              {callWs && <Btn size="sm" onClick={() => setCallWs("")}>{t("全部工作区", "All workspaces")}</Btn>}
              <SearchBox value={callQuery} onChange={setCallQuery} placeholder={t("搜索 ID / 目标 / 发起方 / 内容…", "Search ID / target / caller / content…")} />
            </div>
            <table className="admin-table">
              <thead>
                <tr><th>ID</th><th>{t("发起方", "Caller")}</th><th>{t("目标", "Target")}</th><th>{t("归属", "Owner")}</th><th>{t("指令", "Instruction")}</th><th>{t("结果", "Result")}</th><th>{t("状态", "Status")}</th><th>{t("时间", "Time")}</th></tr>
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
                      {c.monitor ? <span title={t("前台监控轮", "Foreground monitor round")}>👀 {c.from_workspace || c.target} (monitor)</span>
                        : c.from_workspace || (c.external_url ? `🔗 ${c.external_url.slice(0, 28)}…` : c.caller || "—")}
                    </td>
                    <td style={{ fontSize: 12 }}>{c.target || (c.external_url ? `🔗 ${t("外部", "external")}` : "—")}</td>
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
                    <td style={{ fontSize: 12 }}>{statusBadge(c.status, t)}</td>
                    <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{fmtDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {resetPwd && (
          <Modal onClose={() => setResetPwd(null)} title={t("密码已重置", "Password reset")}>
            <p style={{ fontSize: 13 }}>
              {t("用户", "User")} <b>{resetPwd.user}</b> {t("的新密码：", "has a new password:")}
            </p>
            <div className="keyrow">
              <div className="keybox" style={{ userSelect: "all" }}>{resetPwd.password}</div>
              <Btn variant="icon" title={t("复制", "copy")} onClick={async () => {
                toast(await copyText(resetPwd.password) ? t("已复制", "Copied") : t("复制失败", "Copy failed"))
              }}>⧉</Btn>
            </div>
            <p style={{ color: "var(--text-weak)", fontSize: 12, marginTop: 10 }}>
              {t("只展示这一次，请立即转告用户。API Key 不受影响（agent 连接不断开）。",
                "Shown only once — tell the user right away. The API Key is unaffected (agents stay connected).")}
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
