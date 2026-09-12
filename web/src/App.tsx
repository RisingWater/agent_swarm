/** agent_swarm 管理端 —— opencode.ai 风格，纯 React 无 UI 库 */
import { useEffect, useState, useCallback, useRef, type ReactNode } from "react"
import { api, pageOrigin, type Workspace, type HelpRequest, type User } from "./api"

const maskKey = (k: string) => "*".repeat(k.length - 2) + k.slice(-2)

// ---------------- 基础组件 ----------------

function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="topnav-logo" style={{ gap: 10 }}>
      <span className="mark" style={{ width: size, height: size }}>&gt;_</span>
      agent_swarm
    </span>
  )
}

function Btn(props: {
  variant?: "primary" | "ghost" | "danger" | "icon"
  size?: "sm"
  disabled?: boolean
  title?: string
  onClick?: () => void
  children?: ReactNode
}) {
  const { variant = "ghost", size, ...rest } = props
  const cls = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : ""].join(" ")
  return <button className={cls} {...rest} />
}

function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null
  return <div className="toast">{msg}</div>
}

function useToast() {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = useCallback((m: string) => {
    setMsg(m)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMsg(null), 2200)
  }, [])
  return { msg, show }
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

function EyeIcon({ off, size = 18 }: { off?: boolean; size?: number }) {
  // 描边风格睁眼/闭眼（闭眼 = 睁眼 + 斜杠），随当前文字色
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {!off && <path d="M4 4l16 16" />}
    </svg>
  )
}

function TrashIcon({ size = 16 }: { size?: number }) {
  // 描边风格垃圾桶，随当前文字色
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

function ChevronIcon({ up, size = 14 }: { up?: boolean; size?: number }) {
  // 展开按钮的箭头：默认向下（点击展开），展开后向上
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{ transform: up ? "rotate(180deg)" : undefined, transition: "transform 0.15s ease" }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function StatusDot({ status }: { status: string }) {
  return (
    <span>
      <span className={`dot ${status}`} />
      <span style={{ fontSize: 12 }}>{status}</span>
    </span>
  )
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <span className={`switch ${on ? "on" : ""}`} onClick={onClick} />
}

function Confirm({ text, onOk, onClose }: { text: string; onOk: () => void; onClose: () => void }) {
  return (
    <div className="confirm-pop" onClick={(e) => e.stopPropagation()}>
      {text}
      <div className="actions">
        <Btn size="sm" variant="ghost" onClick={onClose}>cancel</Btn>
        <Btn size="sm" variant="danger" onClick={() => { onOk(); onClose() }}>confirm</Btn>
      </div>
    </div>
  )
}

// ---------------- 应用骨架 ----------------

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("swarm_token"))
  const [page, setPage] = useState<"account" | "workspaces" | "help">("account")
  const { msg, show: toast } = useToast()

  if (!token)
    return <LoginPage onLogin={(t) => { localStorage.setItem("swarm_token", t); setToken(t) }} />

  return (
    <>
      <header className="topnav">
        <Logo />
        <nav className="topnav-links">
          <a className={page === "account" ? "active" : ""} onClick={() => setPage("account")}>接入</a>
          <a className={page === "workspaces" ? "active" : ""} onClick={() => setPage("workspaces")}>工作区</a>
          <a className={page === "help" ? "active" : ""} onClick={() => setPage("help")}>求助记录</a>
          <span className="user">{localStorage.getItem("swarm_user")}</span>
          <button
            onClick={() => {
              localStorage.removeItem("swarm_token")
              localStorage.removeItem("swarm_user")
              setToken(null)
            }}
          >
            退出
          </button>
        </nav>
      </header>
      <main className="page">
        {page === "account" && <AccountPage toast={toast} />}
        {page === "workspaces" && <WorkspacesPage toast={toast} />}
        {page === "help" && <HelpPage />}
      </main>
      <Toast msg={msg} />
    </>
  )
}

// 用 context 传 toast 简化：这里直接用一个模块级事件太 hacky，
// 改为每个页面自己持有 toast。

// ---------------- 登录/注册 ----------------

function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [apiKeyShow, setApiKeyShow] = useState<string | null>(null)
  const [err, setErr] = useState("")

  const submit = async () => {
    setLoading(true)
    setErr("")
    try {
      if (mode === "login") {
        const r = await api.login(username, password)
        localStorage.setItem("swarm_user", r.user.username)
        onLogin(r.token)
      } else {
        const r = await api.register(username, password)
        setApiKeyShow(r.api_key)
      }
    } catch (e: any) {
      setErr(e.message)
    }
    setLoading(false)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <Logo size={44} />
        <h1>agent_swarm</h1>
        <p>multi-agent coordination hub</p>
      </div>
      <div style={{ width: 380 }}>
        <div className="tablist" role="tablist">
          <button role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>login</button>
          <button role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>register</button>
        </div>
        <div className="tabpanel">
          <div style={{ display: "grid", gap: 12 }}>
            <input className="field" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input className="field" type="password" placeholder="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()} />
            {err && <div style={{ color: "#d4494b", fontSize: 12 }}>{err}</div>}
            <button className="btn btn-primary" style={{ justifyContent: "center" }} disabled={loading} onClick={submit}>
              {loading ? "..." : mode}
            </button>
          </div>
        </div>
      </div>
      {apiKeyShow && (
        <Modal title="your api key" onClose={() => { setApiKeyShow(null); setMode("login") }}>
          <p style={{ fontSize: 13, color: "var(--text-weak)", marginTop: 0 }}>
            key 可以随时在「接入」页查看，但请妥善保管：
          </p>
          <div className="keybox" style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>
            {apiKeyShow}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <Btn variant="primary" onClick={() => { setApiKeyShow(null); setMode("login") }}>ok, saved</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------- 接入 ----------------

function AccountPage({ toast }: { toast: (m: string) => void }) {
  const [me, setMe] = useState<(User & { api_key: string }) | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [plat, setPlat] = useState<"sh" | "ps1">(
    /Win/i.test(navigator.platform) ? "ps1" : "sh",
  )

  const refresh = useCallback(() => {
    api.me().then(setMe).catch((e) => toast(e.message))
  }, [toast])
  useEffect(() => { refresh() }, [refresh])

  const reset = async () => {
    try {
      await api.resetApiKey()
      toast("API Key 已重置")
      refresh()
    } catch (e: any) { toast(e.message) }
  }

  const key = me?.api_key ?? ""
  const installCmd =
    plat === "sh"
      ? `curl -fsSL ${pageOrigin}/download/install.sh | bash -s -- --api-key ${key}`
      : `& ([scriptblock]::Create((irm ${pageOrigin}/download/install.ps1))) -ApiKey ${key}`

  return (
    <>
      <h1 className="page-title">接入</h1>
      <p className="page-sub">管理 API Key，将 AI 编程工具接入 agent_swarm。</p>

      <p className="section-label">[ api key ]</p>
      <div className="keyrow">
        <div className="keybox">
          {me ? (showKey ? key : maskKey(key)) : "loading..."}
        </div>
        <Btn variant="icon" title={showKey ? "hide" : "show"} onClick={() => setShowKey(!showKey)}>
          <EyeIcon off={!showKey} />
        </Btn>
        <Btn variant="icon" title="copy" onClick={() => {
          navigator.clipboard.writeText(key)
          toast("已复制")
        }}>⧉</Btn>
        <ConfirmWrap text="重置后旧 Key 立即失效，所有 agent 将断开连接。确认？" onOk={reset}>
          <Btn size="sm" variant="danger">reset</Btn>
        </ConfirmWrap>
      </div>

      <hr className="rule" />

      <p className="section-label">[ install ]</p>
      <p style={{ marginTop: 0, color: "var(--text-weak)" }}>
        在装有 AI 编程工具的机器上执行：
      </p>
      <div className="tablist tablist-inline">
        <button role="tab" aria-selected={plat === "sh"} onClick={() => setPlat("sh")}>
          macOS / linux
        </button>
        <button role="tab" aria-selected={plat === "ps1"} onClick={() => setPlat("ps1")}>
          windows
        </button>
      </div>
      <div className="cmdblock cmdblock-joined">
        <span className="cmd-text">
          <span className="prompt">{plat === "sh" ? "$" : "PS>"}</span>
          {key ? installCmd : plat === "sh" ? "# 请先获取 api key" : "# 请先获取 api key"}
        </span>
        <Btn variant="icon" title="copy" onClick={() => {
          navigator.clipboard.writeText(installCmd)
          toast("安装命令已复制")
        }}>⧉</Btn>
      </div>
    </>
  )
}

// 简易 Popconfirm：点击按钮区域弹出
function ConfirmWrap({ text, onOk, children }: { text: string; onOk: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: "relative" }}>
      <span onClick={() => setOpen(!open)}>{children}</span>
      {open && <Confirm text={text} onOk={onOk} onClose={() => setOpen(false)} />}
    </span>
  )
}

// ---------------- 工作区 ----------------

function WorkspacesPage({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Workspace[]>([])
  const [detail, setDetail] = useState<Workspace | null>(null)
  const [delTarget, setDelTarget] = useState<Workspace | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    try { setList(await api.workspaces()) } catch (e: any) { toast(e.message) }
  }, [toast])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const toggle = async (w: Workspace) => {
    try {
      if (w.status === "disabled") await api.enableWorkspace(w.id)
      else await api.disableWorkspace(w.id)
      toast(w.status === "disabled" ? "已启用" : "已禁用")
      refresh()
    } catch (e: any) { toast(e.message) }
  }

  const del = async (w: Workspace) => {
    try {
      await api.deleteWorkspace(w.id)
      toast("deleted")
      refresh()
    } catch (e: any) { toast(e.message) }
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <h1 className="page-title">工作区</h1>
      <p className="page-sub">你的 agent 工作区及在线状态，每 10s 自动刷新。</p>
      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 60 }}></th>
            <th>ID</th>
            <th>名称</th>
            <th>状态</th>
            <th>路径</th>
            <th>用途</th>
            <th style={{ width: 110 }}></th>
          </tr>
        </thead>
        <tbody>
          {list.map((w) => (
            <tr key={w.id}>
              <td><Switch on={w.status !== "disabled"} onClick={() => toggle(w)} /></td>
              <td style={{ color: "var(--text-weak)", fontSize: 12, fontFamily: "var(--font-mono)" }}>{w.id}</td>
              <td className="strong"><a className="link" onClick={() => setDetail(w)}>{w.name}</a></td>
              <td title={w.last_heartbeat ? `最后心跳: ${new Date(w.last_heartbeat + "Z").toLocaleString()}` : undefined}>
                <StatusDot status={w.status} />
                {w.status === "offline" && w.last_heartbeat && (
                  <span style={{ color: "var(--text-weak)", fontSize: 12, marginLeft: 6 }}>
                    {new Date(w.last_heartbeat + "Z").toLocaleString()}
                  </span>
                )}
              </td>
              <td title={w.path} style={{ color: "var(--text-weak)", fontSize: 12 }}>{w.path}</td>
              <td className="purpose-td">
                <div className={`purpose-cell ${expanded.has(w.id) ? "open" : ""}`}>
                  <span className="purpose-text">{w.purpose}</span>
                  <span
                    className="expander"
                    title={expanded.has(w.id) ? "收起" : "展开"}
                    onClick={() => toggleExpand(w.id)}
                  >
                    <ChevronIcon up={expanded.has(w.id)} />
                  </span>
                </div>
              </td>
              <td>
                {w.status !== "online" && (
                  <Btn variant="icon" title="删除" onClick={() => setDelTarget(w)}>
                    <TrashIcon />
                  </Btn>
                )}
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr><td colSpan={5} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
              [*] 暂无工作区 — 在目标机器执行接入页的安装命令
            </td></tr>
          )}
        </tbody>
      </table>

      {delTarget && (
        <Modal title={`删除 ${delTarget.name}？`} onClose={() => setDelTarget(null)}>
          <p style={{ margin: 0, color: "var(--text-weak)", fontSize: 14 }}>删除后工作区将从列表移除，不可恢复。</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setDelTarget(null)}>取消</Btn>
            <Btn size="sm" variant="danger" onClick={() => { del(delTarget); setDelTarget(null) }}>确认删除</Btn>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          <dl className="dl">
            <dt>状态</dt><dd><StatusDot status={detail.status} /></dd>
            <dt>路径</dt><dd>{detail.path}</dd>
            <dt>用途</dt><dd>{detail.purpose || "-"}</dd>
            <dt>能力</dt><dd>{detail.capabilities || "-"}</dd>
            <dt>备注</dt><dd>{detail.notes || "-"}</dd>
            <dt>所有者</dt><dd>{detail.owner?.username ?? "-"}</dd>
            <dt>最后心跳</dt>
            <dd>{detail.last_heartbeat ? new Date(detail.last_heartbeat + "Z").toLocaleString() : "-"}</dd>
          </dl>
        </Modal>
      )}
    </>
  )
}

// ---------------- 求助记录 ----------------

function HelpPage() {
  const [list, setList] = useState<HelpRequest[]>([])
  const [detail, setDetail] = useState<HelpRequest | null>(null)

  useEffect(() => {
    const load = () => api.helpRequests().then(setList).catch(() => {})
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [])

  return (
    <>
      <h1 className="page-title">求助记录</h1>
      <p className="page-sub">agent 之间的互助请求历史。</p>
      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 100 }}>time</th>
            <th style={{ width: 140 }}>from</th>
            <th style={{ width: 140 }}>to</th>
            <th style={{ width: 110 }}>mode</th>
            <th style={{ width: 110 }}>status</th>
            <th>question</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td style={{ color: "var(--text-weak)", fontSize: 12 }}>{new Date(r.created_at + "Z").toLocaleTimeString()}</td>
              <td>{r.requester?.name ?? "-"}</td>
              <td>{r.target?.name ?? "-"}</td>
              <td style={{ color: "var(--text-weak)" }}>{r.mode}</td>
              <td><span className={`status-pill ${r.status}`}>{r.status}</span></td>
              <td><a className="link" onClick={() => setDetail(r)}>{r.question}</a></td>
            </tr>
          ))}
          {!list.length && (
            <tr><td colSpan={6} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
              [*] 暂无求助记录
            </td></tr>
          )}
        </tbody>
      </table>

      {detail && (
        <Modal title="help request" onClose={() => setDetail(null)}>
          <dl className="dl">
            <dt>from</dt><dd>{detail.requester?.name} ({detail.requester?.path})</dd>
            <dt>to</dt><dd>{detail.target?.name} ({detail.target?.path})</dd>
            <dt>mode</dt><dd>{detail.mode}</dd>
            <dt>status</dt><dd>{detail.status}</dd>
            <dt>question</dt><dd>{detail.question}</dd>
            <dt>result</dt><dd>{detail.status === "failed" ? detail.error : (detail.result ?? "-")}</dd>
          </dl>
        </Modal>
      )}
    </>
  )
}
