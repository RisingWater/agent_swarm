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
  const installCmd = `curl -fsSL ${pageOrigin}/download/install.sh | bash -s -- --api-key ${key}`

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
          {showKey ? "🙈" : "👁"}
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
      <div className="cmdblock">
        <span className="cmd-text">
          <span className="prompt">$</span>
          {key ? installCmd : "# 请先获取 api key"}
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

  return (
    <>
      <h1 className="page-title">工作区</h1>
      <p className="page-sub">你的 agent 工作区及在线状态，每 10s 自动刷新。</p>
      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 100 }}>status</th>
            <th style={{ width: 160 }}>name</th>
            <th>path</th>
            <th>purpose</th>
            <th style={{ width: 100 }}>owner</th>
            <th style={{ width: 100 }}>heartbeat</th>
            <th style={{ width: 110 }}></th>
          </tr>
        </thead>
        <tbody>
          {list.map((w) => (
            <tr key={w.id}>
              <td><StatusDot status={w.status} /></td>
              <td className="strong"><a className="link" onClick={() => setDetail(w)}>{w.name}</a></td>
              <td title={w.path} style={{ color: "var(--text-weak)", fontSize: 12 }}>{w.path}</td>
              <td title={w.purpose}>{w.purpose}</td>
              <td style={{ color: "var(--text-weak)" }}>{w.owner?.username}</td>
              <td style={{ color: "var(--text-weak)", fontSize: 12 }}>
                {w.last_heartbeat ? new Date(w.last_heartbeat + "Z").toLocaleTimeString() : "-"}
              </td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Switch on={w.status !== "disabled"} onClick={() => toggle(w)} />
                  {w.status !== "online" && (
                    <ConfirmWrap text={`delete ${w.name}?`} onOk={() => del(w)}>
                      <Btn size="sm" variant="danger">rm</Btn>
                    </ConfirmWrap>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr><td colSpan={7} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
              [*] no workspaces yet — 在目标机器执行接入页的安装命令
            </td></tr>
          )}
        </tbody>
      </table>

      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          <dl className="dl">
            <dt>status</dt><dd><StatusDot status={detail.status} /></dd>
            <dt>path</dt><dd>{detail.path}</dd>
            <dt>purpose</dt><dd>{detail.purpose || "-"}</dd>
            <dt>capabilities</dt><dd>{detail.capabilities || "-"}</dd>
            <dt>notes</dt><dd>{detail.notes || "-"}</dd>
            <dt>owner</dt><dd>{detail.owner?.username ?? "-"}</dd>
            <dt>heartbeat</dt>
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
              [*] no help requests
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
