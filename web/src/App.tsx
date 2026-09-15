/** agent_swarm 管理端 —— opencode.ai 风格，纯 React 无 UI 库 */
import { useEffect, useState, useCallback, useRef, type ReactNode } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, pageOrigin, type Workspace, type WorkspaceCall, type User } from "./api"

const maskKey = (k: string) => "*".repeat(k.length - 2) + k.slice(-2)

/** 结果文本（多为 markdown）渲染；无内容返回 null */
function Md({ text }: { text: string | null | undefined }) {
  if (!text?.trim()) return null
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}

/** 表格上方搜索框（纯前端过滤） */
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search-box">
      <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        className="field"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="search-clear" title="清空" onClick={() => onChange("")}>×</button>
      )}
    </div>
  )
}

/** 大小写不敏感的子串匹配 */
function hit(haystack: string | null | undefined, q: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(q)
}

/** 后端 ISO 时间串 → 本地时间显示；非法输入返回 "-"（避免 Invalid Date） */
function fmtTime(iso: string | null | undefined, mode: "time" | "datetime" = "time"): string {
  if (!iso) return "-"
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z")
  if (isNaN(d.getTime())) return "-"
  return mode === "time" ? d.toLocaleTimeString() : d.toLocaleString()
}

// ---------------- 基础组件 ----------------

/** 虫群标志：六个个体围绕 AI 核心汇聚 */
function SwarmMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <g fill="currentColor">
        <ellipse cx="24" cy="12" rx="4.2" ry="5.5" />
        <ellipse cx="34.4" cy="18" rx="4.2" ry="5.5" transform="rotate(120 34.4 18)" />
        <ellipse cx="34.4" cy="30" rx="4.2" ry="5.5" transform="rotate(60 34.4 30)" />
        <ellipse cx="24" cy="36" rx="4.2" ry="5.5" />
        <ellipse cx="13.6" cy="30" rx="4.2" ry="5.5" transform="rotate(-60 13.6 30)" />
        <ellipse cx="13.6" cy="18" rx="4.2" ry="5.5" transform="rotate(-120 13.6 18)" />
      </g>
      <circle cx="24" cy="24" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="24" cy="24" r="1" fill="currentColor" />
    </svg>
  )
}

function Logo({ size = 26 }: { size?: number }) {
  return (
    <>
      <SwarmMark size={size} />
      agent_swarm
    </>
  )
}

function Btn(props: {
  variant?: "primary" | "ghost" | "danger" | "icon"
  size?: "sm"
  disabled?: boolean
  title?: string
  className?: string
  onClick?: () => void
  children?: ReactNode
}) {
  const { variant = "ghost", size, className, ...rest } = props
  const cls = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : "", className ?? ""].join(" ")
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

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className={`dialog${wide ? " dialog-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
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

export type Page = "home" | "docs" | "workspaces" | "calls" | "account" | "nexus" | "login"

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("swarm_token"))
  const [page, setPage] = useState<Page>("home")
  const { msg, show: toast } = useToast()

  const loggedIn = !!token
  const username = localStorage.getItem("swarm_user")

  // 未登录：可见页面只有 首页/文档，受保护页面跳回首页
  const effectivePage: Page =
    !loggedIn && (page === "workspaces" || page === "calls" || page === "account" || page === "nexus")
      ? "home"
      : page

  // 切换页面时回到顶部
  const goto = (p: Page) => {
    setPage(p)
    window.scrollTo({ top: 0 })
  }

  return (
    <>
      <header className="topnav">
        <a className="topnav-logo" href="#" onClick={(e) => { e.preventDefault(); goto("home") }} title="首页">
          <Logo />
        </a>
        <nav className="topnav-links">
          <a className={effectivePage === "home" ? "active" : ""} onClick={() => goto("home")}>首页</a>
          <a className={effectivePage === "docs" ? "active" : ""} onClick={() => goto("docs")}>文档</a>
          {loggedIn && (
            <>
              <a className={effectivePage === "nexus" ? "active" : ""} onClick={() => goto("nexus")}>中枢</a>
              <a className={effectivePage === "workspaces" ? "active" : ""} onClick={() => goto("workspaces")}>工作区</a>
              <a className={effectivePage === "calls" ? "active" : ""} onClick={() => goto("calls")}>调用记录</a>
            </>
          )}
          {loggedIn ? (
            <a
              className={`user${effectivePage === "account" ? " active" : ""}`}
              title="账号：API Key / 修改密码"
              onClick={() => goto("account")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
              </svg>
              {username}
            </a>
          ) : (
            <a className="user" title="登录或注册" onClick={() => setPage("login")}>登录 / 注册</a>
          )}
          <a
            className="github-link"
            href="https://github.com/RisingWater/agent_swarm"
            target="_blank"
            rel="noreferrer"
            title="GitHub 仓库"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
          {loggedIn && (
            <button
              onClick={() => {
                localStorage.removeItem("swarm_token")
                localStorage.removeItem("swarm_user")
                setToken(null)
                setPage("home")
              }}
            >
              退出
            </button>
          )}
        </nav>
      </header>
      <main className={effectivePage === "home" || effectivePage === "docs" ? "page page-full" : "page"}>
        {effectivePage === "home" && (
          <HomePage
            toast={toast}
            loggedIn={loggedIn}
            onGoAccount={() => goto("account")}
            onOpenLogin={() => setPage("login")}
            onGoDocs={() => goto("docs")}
          />
        )}
        {effectivePage === "docs" && <DocsPage />}
        {effectivePage === "nexus" && <NexusPage toast={toast} />}
        {effectivePage === "workspaces" && <WorkspacesPage toast={toast} />}
        {effectivePage === "calls" && <CallsPage toast={toast} />}
        {effectivePage === "account" && <AccountPage toast={toast} />}
      </main>
      <Toast msg={msg} />
      {page === "login" && (
        <LoginPage
          onLogin={(t) => { localStorage.setItem("swarm_token", t); setToken(t); setPage("home") }}
          onClose={() => setPage("home")}
        />
      )}
    </>
  )
}

// 用 context 传 toast 简化：这里直接用一个模块级事件太 hacky，
// 改为每个页面自己持有 toast。

// ---------------- 登录/注册（弹窗形式，覆盖在当前页上） ----------------

function LoginPage({ onLogin, onClose }: { onLogin: (token: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [apiKeyShow, setApiKeyShow] = useState<string | null>(null)
  const [pendingToken, setPendingToken] = useState("")
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
        localStorage.setItem("swarm_user", r.user.username)
        setPendingToken(r.token)
        setApiKeyShow(r.api_key)
      }
    } catch (e: any) {
      setErr(e.message)
    }
    setLoading(false)
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog auth-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="auth-hero-row" style={{ marginBottom: 14 }}>
          <SwarmMark size={40} />
          <h1 style={{ fontSize: 26, margin: 0 }}>agent_swarm</h1>
        </div>
        <div className="tablist tablist-inline" style={{ marginBottom: 0 }}>
          <button role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>登录</button>
          <button role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>注册</button>
        </div>
        <div className="tabpanel">
          <div style={{ display: "grid", gap: 12 }}>
            <input className="field" placeholder="用户名（2-32 位）" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input className="field" type="password" placeholder="密码（至少 6 位）" value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()} />
            {err && <div style={{ color: "#d4494b", fontSize: 12 }}>{err}</div>}
            <button className="btn btn-primary" style={{ justifyContent: "center" }} disabled={loading} onClick={submit}>
              {loading ? "请稍候…" : mode === "login" ? "登录" : "注册"}
            </button>
          </div>
        </div>
      </div>
      {apiKeyShow && (
        <Modal title="你的 API Key" onClose={() => { setApiKeyShow(null); onLogin(pendingToken) }}>
          <p style={{ fontSize: 13, color: "var(--text-weak)", marginTop: 0 }}>
            key 可以随时在「账号 → API Key」查看，但请妥善保管：
          </p>
          <div className="keybox" style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>
            {apiKeyShow}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <Btn variant="primary" onClick={() => { setApiKeyShow(null); onLogin(pendingToken) }}>我已保存</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------- 账号（左侧二级菜单：API Key / 修改密码） ----------------

function AccountPage({ toast }: { toast: (m: string) => void }) {
  const [tab, setTab] = useState<"apikey" | "password">("apikey")
  return (
    <div className="subpage">
      <aside className="subpage-toc">
        <p className="section-label">[ 账号 ]</p>
        <a className={`subpage-item${tab === "apikey" ? " active" : ""}`} onClick={() => setTab("apikey")}>
          API Key
        </a>
        <a className={`subpage-item${tab === "password" ? " active" : ""}`} onClick={() => setTab("password")}>
          修改密码
        </a>
      </aside>
      <div className="subpage-body">
        {tab === "apikey" ? <ApiKeyPanel toast={toast} /> : <PasswordForm toast={toast} />}
      </div>
    </div>
  )
}

function ApiKeyPanel({ toast }: { toast: (m: string) => void }) {
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

  return (
    <>
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
      <p style={{ marginTop: 12, color: "var(--text-weak)", fontSize: 13 }}>
        安装接入命令在「接入」页生成，会自动带上当前 Key。
      </p>
    </>
  )
}

function PasswordForm({ toast }: { toast: (m: string) => void }) {
  const [username] = useState(localStorage.getItem("swarm_user") ?? "")
  const [oldPwd, setOldPwd] = useState("")
  const [newPwd, setNewPwd] = useState("")
  const [newPwd2, setNewPwd2] = useState("")
  const [loading, setLoading] = useState(false)
  const [show, setShow] = useState(false)

  const submit = async () => {
    if (!oldPwd || !newPwd) return toast("请填写完整")
    if (newPwd !== newPwd2) return toast("两次输入的新密码不一致")
    if (newPwd.length < 6) return toast("新密码至少 6 位")
    setLoading(true)
    try {
      await api.changePassword(oldPwd, newPwd)
      setOldPwd("")
      setNewPwd("")
      setNewPwd2("")
      toast("密码修改成功")
    } catch (e) {
      toast(e instanceof Error ? e.message : "修改失败")
    } finally {
      setLoading(false)
    }
  }

  const eye = (
    <button className="pwd-eye" title={show ? "隐藏" : "显示"} onClick={() => setShow(!show)}>
      <EyeIcon off={show} />
    </button>
  )

  return (
    <div style={{ width: 400, display: "grid", gap: 12, paddingTop: 20 }}>
      <label className="pwd-label">账号 <span style={{ color: "var(--text-strong)" }}>{username}</span> · 修改后需用新密码重新登录</label>
      <div className="pwd-row">
        <input className="field" type={show ? "text" : "password"} placeholder="当前密码" value={oldPwd}
          onChange={(e) => setOldPwd(e.target.value)} />
        {eye}
      </div>
      <div className="pwd-row">
        <input className="field" type={show ? "text" : "password"} placeholder="新密码（至少 6 位）" value={newPwd}
          onChange={(e) => setNewPwd(e.target.value)} />
        {eye}
      </div>
      <div className="pwd-row">
        <input className="field" type={show ? "text" : "password"} placeholder="再输入一次新密码" value={newPwd2}
          onChange={(e) => setNewPwd2(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} />
        {eye}
      </div>
      <button className="btn btn-primary" style={{ justifyContent: "center", marginTop: 4 }} disabled={loading} onClick={submit}>
        {loading ? "..." : "确认修改"}
      </button>
    </div>
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

// ---------------- 首页 ----------------

function HomePage({ toast, loggedIn, onGoAccount, onOpenLogin, onGoDocs }: { toast: (m: string) => void; loggedIn: boolean; onGoAccount: () => void; onOpenLogin: () => void; onGoDocs: () => void }) {
  const [me, setMe] = useState<(User & { api_key: string }) | null>(null)
  const [plat, setPlat] = useState<"sh" | "ps1">(
    /Win/i.test(navigator.platform) ? "ps1" : "sh",
  )

  useEffect(() => {
    if (loggedIn) api.me().then(setMe).catch(() => {})
  }, [loggedIn])

  const key = me?.api_key ?? ""
  const placeholder = "你的apikey"
  const cmdKey = loggedIn ? key : placeholder
  const installCmd =
    plat === "sh"
      ? `curl -fsSL ${pageOrigin}/download/install.sh | bash -s -- --api-key ${cmdKey}`
      : `& ([scriptblock]::Create((irm ${pageOrigin}/download/install.ps1))) -ApiKey ${cmdKey}`

  return (
    <div className="home">
      {/* 1. Hero：图标+文字 logo 一行 + 一句话介绍 */}
      <section className="home-hero">
        <div className="home-hero-row">
          <SwarmMark size={56} />
          <h1>agent_swarm</h1>
        </div>
        <p className="home-tagline">
          多 agent 协作中枢 —— 把你的 AI 编程工具组成一个虫群，让它们互相调用、协同完成任务。
        </p>
      </section>

      {/* 2. 马上安装 */}
      <section className="home-install">
        <h2>马上安装</h2>
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
            {loggedIn && !key ? "# 正在获取 api key…" : installCmd}
          </span>
          {loggedIn && (
            <Btn variant="icon" title="copy" onClick={() => {
              navigator.clipboard.writeText(installCmd)
              toast("安装命令已复制")
            }}>⧉</Btn>
          )}
        </div>
        {loggedIn ? (
          <p className="home-hint" style={{ marginTop: 10 }}>
            命令中的 API Key 可在 <a className="link" onClick={onGoAccount}>账号</a> 页查看或重置。
          </p>
        ) : (
          <p className="home-hint" style={{ marginTop: 10 }}>
            <a className="link" onClick={onOpenLogin}>注册</a>或者
            <a className="link" onClick={onOpenLogin}>登录</a>账号即可安装。
          </p>
        )}
        <SupportedAgents />
      </section>

      {/* 3. 演示视频（懒加载：点击封面才开始加载播放） */}
      <section className="home-video">
        <VideoPlayer src="/agent_swarm.mp4" />
      </section>

      {/* 4. 什么是 agent_swarm？ */}
      <section className="home-about">
        <h2>什么是 agent_swarm？</h2>
        <p>
          agent_swarm 是一个自托管的多 agent 协作平台。每个 AI 编程工具（如 opencode）作为一个
          <b> agent 工作区</b>注册到中枢，虫群中的任何 agent 都可以把任务派发给其他 agent 执行——
          就像一群工蜂协作：你写代码，它跑测试，另一个整理文档。
        </p>
        <div className="home-grid">
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="mcp" />
              <h3>开放架构，逐步支持更多 agent</h3>
            </div>
            <p>面向 agent 的操作走标准 MCP 工具，工作区之间的任务派发走标准 <b>A2A 协议</b>（Linux Foundation 开放标准）。基于开放协议，claude code、deepseek harness、pi 等更多 agent 客户端得以逐步接入。</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="swarm" />
              <h3>跨 agent 任务派发</h3>
            </div>
            <p>一条指令把任务交给另一个工作区的 agent：支持<b>前台注入</b>（任务直接进入对方当前会话，实时可见）与<b>后台会话</b>（独立会话静默执行，按来源归组）两种方式，结果自动回传。</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="terminal" />
              <h3>中枢 Nexus</h3>
            </div>
            <p>在网页上选择在线工作区直接下达指令，实时观看 agent 的思考、工具调用与答复，权限请求和提问可直接点选应答。</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="eye" />
              <h3>监控模式</h3>
            </div>
            <p>开启后（默认开），你在 opencode TUI 里的日常对话会按轮次实时同步到网页中枢：提问、思考、工具调用、回答全程可见，权限请求远程应答，历史随时回溯——像给 agent 开了一扇观察窗。</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="pulse" />
              <h3>在线状态与心跳</h3>
            </div>
            <p>插件每 30 秒心跳保活，工作区看板实时展示每个 agent 的在线/离线状态与当前会话。</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="shield" />
              <h3>自托管 & 轻量</h3>
            </div>
            <p>单个 FastAPI 服务 + SQLite，一条命令启动，数据完全留在你自己的机器上。</p>
          </div>
        </div>
      </section>

      {/* 5. 它可以做什么？ */}
      <section className="home-about">
        <h2>它可以做什么？</h2>
        <ul className="home-list">
          <li>让前端 agent 把后端 bug 派发给后端工作区的 agent 修复</li>
          <li>让一个 agent 去另一个仓库执行测试、汇总结果</li>
          <li>在网页「中枢」里给任意在线 agent 直接下达指令，实时围观它干活</li>
          <li>开启监控模式，把 TUI 里和 agent 的日常对话实时同步到网页，随时远程回看</li>
          <li>集中管理所有 AI 工作区的用途说明、备注与在线状态</li>
          <li>回溯每一次跨 agent 调用的指令与结果（调用记录）</li>
        </ul>
      </section>

      {/* 6. 阅读文档 */}
      <section className="home-docs-cta">
        <a className="btn btn-primary docs-btn" onClick={onGoDocs}>阅读文档 →</a>
      </section>
    </div>
  )
}

/** 演示视频：进入视口自动静音播放一次，停在最后一帧，无控件；点击可切换声音 */
function VideoPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [muted, setMuted] = useState(true)
  const playedRef = useRef(false)

  // 进入视口才开始播放（省流量），离开视口暂停；只播一次，播完停在最后一帧
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onEnded = () => { playedRef.current = true }
    v.addEventListener("ended", onEnded)
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!playedRef.current) v.play().catch(() => {})
        } else if (!playedRef.current) {
          v.pause()
        }
      },
      { threshold: 0.3 },
    )
    io.observe(v)
    return () => {
      io.disconnect()
      v.removeEventListener("ended", onEnded)
    }
  }, [])

  return (
    <div className="video-placeholder">
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        playsInline
        preload="metadata"
        style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
      />
      {/* 覆盖层：整块可点击切换声音，右下角显示当前状态 */}
      <button
        className="video-sound-toggle"
        title={muted ? "开启声音" : "关闭声音"}
        onClick={() => setMuted(!muted)}
      >
        {muted ? "🔇 已静音，点击开启声音" : "🔊 声音开启，点击静音"}
      </button>
    </div>
  )
}

/** agent 工具图标（黑白单色，统一 24x24 viewBox 线条风格） */
function AgentToolIcon({ tool }: { tool: "opencode" | "claude" | "deepseek" | "pi" | "more" }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  }
  switch (tool) {
    case "opencode":
      // 终端提示符方块（opencode 官方气质：>_）
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="m7.5 9 3 3-3 3" />
          <path d="M12.5 15H17" />
        </svg>
      )
    case "claude":
      // Claude 官方星芒 logo（fill 路径，viewBox 0 0 125 125）
      return (
        <svg width={18} height={18} viewBox="0 0 125 125" fill="currentColor" aria-hidden>
          <path d="M54.375 118.75L56.125 111L58.125 101L59.75 93L61.25 83.125L62.125 79.875L62 79.625L61.375 79.75L53.875 90L42.5 105.375L33.5 114.875L31.375 115.75L27.625 113.875L28 110.375L30.125 107.375L42.5 91.5L50 81.625L54.875 76L54.75 75.25H54.5L21.5 96.75L15.625 97.5L13 95.125L13.375 91.25L14.625 90L24.5 83.125L49.125 69.375L49.5 68.125L49.125 67.5H47.875L43.75 67.25L29.75 66.875L17.625 66.375L5.75 65.75L2.75 65.125L0 61.375L0.25 59.5L2.75 57.875L6.375 58.125L14.25 58.75L26.125 59.5L34.75 60L47.5 61.375H49.5L49.75 60.5L49.125 60L48.625 59.5L36.25 51.25L23 42.5L16 37.375L12.25 34.75L10.375 32.375L9.625 27.125L13 23.375L17.625 23.75L18.75 24L23.375 27.625L33.25 35.25L46.25 44.875L48.125 46.375L49 45.875V45.5L48.125 44.125L41.125 31.375L33.625 18.375L30.25 13L29.375 9.75C29.0417 8.625 28.875 7.375 28.875 6L32.75 0.750006L34.875 0L40.125 0.750006L42.25 2.625L45.5 10L50.625 21.625L58.75 37.375L61.125 42.125L62.375 46.375L62.875 47.75H63.75V47L64.375 38L65.625 27.125L66.875 13.125L67.25 9.125L69.25 4.375L73.125 1.87501L76.125 3.25L78.625 6.875L78.25 9.125L76.875 18.75L73.875 33.875L72 44.125H73.125L74.375 42.75L79.5 36L88.125 25.25L91.875 21L96.375 16.25L99.25 14H104.625L108.5 19.875L106.75 26L101.25 33L96.625 38.875L90 47.75L86 54.875L86.375 55.375H87.25L102.125 52.125L110.25 50.75L119.75 49.125L124.125 51.125L124.625 53.125L122.875 57.375L112.625 59.875L100.625 62.25L82.75 66.5L82.5 66.625L82.75 67L90.75 67.75L94.25 68H102.75L118.5 69.125L122.625 71.875L125 75.125L124.625 77.75L118.25 80.875L109.75 78.875L89.75 74.125L83 72.5H82V73L87.75 78.625L98.125 88L111.25 100.125L111.875 103.125L110.25 105.625L108.5 105.375L97 96.625L92.5 92.75L82.5 84.375H81.875V85.25L84.125 88.625L96.375 107L97 112.625L96.125 114.375L92.875 115.5L89.5 114.875L82.25 104.875L74.875 93.5L68.875 83.375L68.25 83.875L64.625 121.625L63 123.5L59.25 125L56.125 122.625L54.375 118.75Z" />
        </svg>
      )
    case "deepseek":
      // DeepSeek 官方鲸鱼 logo（fill 路径，viewBox 0 0 38 28）
      return (
        <svg width={22} height={17} viewBox="0 0 38 28" fill="currentColor" aria-hidden>
          <path d="M33.615 2.598c-.36-.176-.515.16-.726.33-.072.055-.132.127-.193.193-.526.562-1.14.93-1.943.887-1.174-.067-2.176.302-3.062 1.2-.188-1.107-.814-1.767-1.766-2.191-.498-.22-1.002-.441-1.35-.92-.244-.341-.31-.721-.433-1.096-.077-.226-.154-.457-.415-.496-.282-.044-.393.193-.504.391-.443.81-.614 1.702-.598 2.605.04 2.033.898 3.652 2.603 4.803.193.132.243.264.182.457-.116.397-.254.782-.376 1.179-.078.253-.194.308-.465.198-.936-.391-1.744-.97-2.458-1.669-1.213-1.173-2.31-2.467-3.676-3.48a16.254 16.254 0 0 0-.975-.668c-1.395-1.354.183-2.467.548-2.599.382-.138.133-.612-1.102-.606-1.234.005-2.364.42-3.803.97a4.34 4.34 0 0 1-.66.193 13.577 13.577 0 0 0-4.08-.143c-2.667.297-4.799 1.558-6.365 3.712C.116 8.436-.327 11.378.215 14.444c.57 3.233 2.22 5.91 4.755 8.002 2.63 2.17 5.658 3.233 9.113 3.03 2.098-.122 4.434-.403 7.07-2.633.664.33 1.362.463 2.518.562.892.083 1.75-.044 2.414-.182 1.04-.22.97-1.184.593-1.36-3.05-1.421-2.38-.843-2.99-1.311 1.55-1.834 3.918-5.093 4.648-9.531.072-.49.164-1.18.153-1.577-.006-.242.05-.336.326-.364a5.903 5.903 0 0 0 2.187-.672c1.977-1.08 2.774-2.853 2.962-4.978.028-.325-.006-.661-.35-.832ZM16.39 21.73c-2.956-2.324-4.39-3.089-4.982-3.056-.554.033-.454.667-.332 1.08.127.407.293.688.526 1.046.16.237.271.59-.161.854-.952.589-2.607-.198-2.685-.237-1.927-1.134-3.537-2.632-4.673-4.68-1.096-1.972-1.733-4.087-1.838-6.345-.028-.545.133-.738.676-.837A6.643 6.643 0 0 1 5.086 9.5c3.017.441 5.586 1.79 7.74 3.927 1.229 1.217 2.159 2.671 3.116 4.092 1.02 1.509 2.115 2.946 3.51 4.125.494.413.887.727 1.263.958-1.135.127-3.028.154-4.324-.87v-.002Zm1.417-9.114a.434.434 0 0 1 .587-.408c.06.022.117.055.16.105a.426.426 0 0 1 .122.303.434.434 0 0 1-.437.435.43.43 0 0 1-.432-.435Zm4.402 2.257c-.283.116-.565.215-.836.226-.421.022-.88-.149-1.13-.358-.387-.325-.664-.506-.78-1.073-.05-.242-.022-.617.022-.832.1-.463-.011-.76-.338-1.03-.265-.22-.603-.28-.974-.28a.8.8 0 0 1-.36-.11c-.155-.078-.283-.27-.161-.508.039-.077.227-.264.271-.297.504-.286 1.085-.193 1.623.022.498.204.875.578 1.417 1.107.553.639.653.815.968 1.295.25.374.476.76.632 1.2.094.275-.028.5-.354.638Z" />
        </svg>
      )
    case "pi":
      // Pi 官方 logo（fill 路径，viewBox 0 0 470 470）
      return (
        <svg width={18} height={18} viewBox="0 0 470 470" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" clipRule="evenodd" d="M0 0H352.07V234.71H234.71V352.07H117.36V469.43H0V0ZM117.36 117.36V234.71H234.71V117.36H117.36Z" />
          <path d="M352.07 234.71H469.43V469.43H352.07V234.71Z" />
        </svg>
      )
    case "more":
      // 其它：问号圆圈
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.2a2.4 2.4 0 1 1 3.2 2.9c-.6.3-.8.7-.8 1.4v.3" />
          <circle cx="12" cy="16.6" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}

/** 按 agent_type 字符串取图标（未识别的用"其它"问号图标） */
function agentToolKind(agentType: string | null | undefined): "opencode" | "claude" | "deepseek" | "pi" | "more" {
  const t = (agentType ?? "").trim().toLowerCase()
  if (t.includes("opencode")) return "opencode"
  if (t.includes("claude")) return "claude"
  if (t.includes("deepseek")) return "deepseek"
  if (t === "pi" || t.startsWith("pi ")) return "pi"
  return "more"
}

/** 工作区名称旁的 agent 类型小图标（识别的类型用品牌色，未知用灰问号） */
function AgentTypeIcon({ type, inherit }: { type: string | null | undefined; inherit?: boolean }) {
  const kind = agentToolKind(type)
  const label = (type ?? "").trim() || "未知 agent"
  // inherit=true：跟随容器文字色（如 TUI 黑底头部要白色），否则用品牌色
  const color = inherit ? "" : kind === "claude" ? "#D97757" : kind === "more" ? "" : "var(--text-strong)"
  return (
    <span className="agent-type-ico" title={label} style={color ? { color } : undefined}>
      <AgentToolIcon tool={kind} />
    </span>
  )
}

/** 首页"已支持的 agent 工具"图标组 */
function SupportedAgents() {
  const tools: { tool: "opencode" | "claude" | "deepseek" | "pi" | "more"; name: string; supported: boolean }[] = [
    { tool: "opencode", name: "opencode", supported: true },
    { tool: "claude", name: "claude code", supported: true },
    { tool: "deepseek", name: "deepseek harness", supported: false },
    { tool: "pi", name: "pi", supported: false },
    { tool: "more", name: "更多 MCP 客户端", supported: false },
  ]
  return (
    <div className="supported-agents">
      <span className="supported-label">已支持</span>
      {tools.map((t) => (
        <span key={t.tool} className={`agent-tile${t.supported ? " supported" : ""}`} title={t.supported ? `${t.name} · 已支持` : `${t.name} · 即将支持`}>
          <AgentToolIcon tool={t.tool} />
          <span className="agent-tile-name">{t.name}</span>
        </span>
      ))}
    </div>
  )
}

/** 特性卡黑白线性图标（与 SwarmMark 同风格：currentColor 描边） */
function FeatureIcon({ kind }: { kind: "mcp" | "swarm" | "pulse" | "shield" | "terminal" | "eye" }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  }
  if (kind === "mcp")
    return (
      <svg {...common}>
        {/* 插头 = 标准协议接入 */}
        <path d="M9 7V3M15 7V3" />
        <path d="M7 7h10v4a5 5 0 0 1-10 0V7Z" />
        <path d="M12 16v5" />
      </svg>
    )
  if (kind === "swarm")
    return (
      <svg {...common}>
        {/* 三只个体汇聚 */}
        <circle cx="12" cy="5.5" r="2.5" />
        <circle cx="5.5" cy="17" r="2.5" />
        <circle cx="18.5" cy="17" r="2.5" />
        <path d="M10.5 8 7 14.5M13.5 8l3.5 6.5M8 17h8" />
      </svg>
    )
  if (kind === "pulse")
    return (
      <svg {...common}>
        {/* 心跳脉冲 */}
        <path d="M3 12h4l2-5 4 10 2-5h6" />
      </svg>
    )

  if (kind === "eye")
    return (
      <svg {...common}>
        {/* 眼睛 = 监控观察窗 */}
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  if (kind === "terminal")
    return (
      <svg {...common}>
        {/* 终端窗口 */}
        <rect x="3" y="4" width="18" height="16" rx="1" />
        <path d="m7 9 3 3-3 3" />
        <path d="M12.5 15H17" />
      </svg>
    )
  return (
    <svg {...common}>
      {/* 盾牌 = 自托管安全 */}
      <path d="M12 3 5 6v5c0 4.5 3 8.2 7 9.5 4-1.3 7-5 7-9.5V6l-7-3Z" />
      <path d="m9.5 12 2 2 3.5-4" />
    </svg>
  )
}

// ---------------- 文档（左侧目录 + 右侧内容，滚动定位） ----------------

const DOC_SECTIONS = [
  { id: "intro", title: "介绍" },
  { id: "install", title: "安装插件" },
  { id: "register", title: "注册工作区" },
  { id: "concepts", title: "核心概念" },
  { id: "commands", title: "命令" },
  { id: "mcp", title: "MCP 工具" },
  { id: "web", title: "Web 管理" },
  { id: "faq", title: "FAQ" },
]

function DocsPage() {
  const [active, setActive] = useState(DOC_SECTIONS[0].id)

  // 点击目录：滚动到对应区块
  const jump = (id: string) => {
    document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
    setActive(id)
  }

  return (
    <div className="subpage">
      <aside className="subpage-toc">
        <p className="section-label">[ 文档 ]</p>
        {DOC_SECTIONS.map((s) => (
          <a key={s.id} className={`subpage-item${active === s.id ? " active" : ""}`}
            onClick={() => jump(s.id)}>
            {s.title}
          </a>
        ))}
      </aside>
      <article className="subpage-body">
        <section id="doc-intro" className="docs-section">
          <h2>介绍</h2>
          <p>
            <b>agent_swarm</b> 把你的 AI 编程工具（opencode 等）组织成一个「虫群」：
            每个工具实例作为一个<b>工作区</b>注册进来，任意 agent 都可以把任务派发给其他 agent 执行——
            你写代码，它跑测试，另一个整理文档。
          </p>
          <p>三个核心特点：</p>
          <ul>
            <li><b>开放标准协议</b> —— agent 操作是标准 MCP 工具，任务派发走标准 A2A 协议（Linux Foundation 开放标准），任何兼容客户端均可接入</li>
            <li><b>跨 agent 任务派发</b> —— 支持前台注入（任务进入对方当前会话，实时可见）与后台会话（独立会话静默执行）两种方式，结果自动回传</li>
            <li><b>中枢 Nexus</b> —— 在网页上直接给任意在线 agent 下指令，实时观看它思考、调用工具、给出答复</li>
            <li><b>实时看板</b> —— 工作区在线状态、每次调用的指令与结果，随时可查</li>
          </ul>
          <p>
            接入后，你的 agent 会多出一组「虫群工具」：注册工作区、查看其他工作区、派发任务、查询结果——
            都可以在对话里自然地让 agent 使用。
          </p>
        </section>

        <section id="doc-install" className="docs-section">
          <h2>安装插件</h2>
          <p>
            插件是 agent 接入虫群的载体，负责心跳保活与接收任务。每个 agent 工具一个插件，
            一条安装命令可以把所有已支持的插件一次装好。
          </p>
          <h3>安装方式</h3>
          <p>
            在目标机器上执行<b>首页</b>生成的安装命令（已自动带上你的账号 API Key）。
            安装器会下载分发包并逐个安装各 agent 插件（可选参数只装指定插件）。
          </p>
          <ul>
            <li>
              <b>opencode</b>：写入服务配置 → 注册 MCP 端点 → 部署心跳插件 → 拷贝 <code>/swarm-*</code> 命令。
              <b>重启 opencode 后生效</b>——插件在会话启动时加载，运行中的会话不会热更新。
            </li>
            <li>
              <b>claude code</b>：<code>claude mcp add</code> 注册 remote MCP（虫群工具）+ 本地 keepalive MCP
              （claude 启动时自动 spawn 保活进程，退出自动回收）→ 拷贝 <code>/swarm-*</code> 命令。
              <b>重启 claude 后生效</b>。claude 工作区支持注册管理、在线状态与后台会话任务执行；
              前台注入暂不支持（见「命令」章节的支持情况表）。
            </li>
          </ul>
          <h3>验证安装</h3>
          <p>
            重启后打开「工作区」页，约 30 秒内应看到该机器的工作区状态点变绿（online）。
            opencode 可查看 <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code>；
            claude 可查看 <code>~/.claude/agent-swarm/keepalive.log</code>。
          </p>
        </section>

        <section id="doc-register" className="docs-section">
          <h2>注册工作区</h2>
          <p>
            安装插件后，把一个项目目录注册为工作区，它才算真正加入虫群（可被发现、被派发任务）。
            一个机器可以注册多个工作区，每个项目一个。
          </p>
          <h3>注册方式</h3>
          <p>任选其一：</p>
          <ul>
            <li>在该项目的 agent 对话里使用 <code>/swarm-add</code> 命令（opencode 与 claude 均可用）</li>
            <li>直接让 agent：「帮我把当前目录注册到虫群」（它会调用 <code>workspace_add</code> 工具）</li>
          </ul>
          <p>
            注册时会要求 agent 总结这个目录的用途与能力（显示在「工作区」页，方便其他 agent 了解找谁帮忙）。
            注册成功后，工作区 ID 会写入项目根的 <code>.agent_swarm/workspace.md</code> 文件，后续心跳自动带身份。
          </p>
          <h3>管理已注册的工作区</h3>
          <p>
            「工作区」页可以启用/禁用（disabled 的工作区不参与任务派发）、删除离线工作区、修改备注。
            也可以在 agent 里用 <code>workspace_enable</code> / <code>workspace_disable</code> 等工具操作。
          </p>
          <h3>开始协作</h3>
          <p>注册完成后，在 agent 对话里让它派发任务即可：</p>
          <pre><code>{`你: 调用 nas_brain 工作区，查看它最新一次 git 提交
agent: (a2a_call) → 对方 TUI 实时出现任务 → 执行 → 结果自动回传`}</code></pre>
        </section>

        <section id="doc-concepts" className="docs-section">
          <h2>核心概念</h2>
          <h3>工作区（Workspace）</h3>
          <p>
            一个接入虫群的 agent 实例。注册后获得唯一 ID，持久化在项目根 <code>.agent_swarm/workspace.md</code> 的
            <code>WORKSPACE_ID:</code> 行。插件每 30 秒心跳保活，超过 90 秒无心跳视为离线；
            禁用（disabled）的工作区不可见、不参与任务派发。
          </p>
          <h3>调用（A2A 协议）</h3>
          <p>
            一次跨 agent 任务派发就是一个 <b>A2A 任务</b>（Linux Foundation A2A 0.3.x 开放协议，
            JSON-RPC over HTTP + WebSocket 事件流），状态流转：
            <code>queued → working → completed / failed / canceled</code>，需要对方确认时进入
            <code>input-required</code>。执行方式分前台/后台两种（见下节），
            完成后最后一条 assistant 回复自动回传给调用方。
          </p>
          <h3>前台会话与后台会话</h3>
          <p>
            每个工作区收到任务时，按配置选择执行方式：
          </p>
          <ul>
            <li>
              <b>前台会话（foreground）</b>：任务直接注入对方<b>正在看的 TUI 会话</b>并弹 toast 通知——
              你在屏幕上就能看到 agent 干活的全部过程（思考、工具调用、答复），也能随时打断、应答权限。
              适合需要人监督的任务。
            </li>
            <li>
              <b>后台会话（background）</b>：目标端 spawn 一个独立的 headless 进程静默执行，
              <b>完全不碰当前 TUI 会话</b>。同一来源（如网页中枢、某个调用方 agent）的任务自动归组到
              同一个后台会话，保证多轮对话的连续性。权限全自动批准（无人值守），默认 30 分钟超时，
              最多 3 个并发。适合耗时任务批量派发、agent 互调时不想打扰对方。
            </li>
          </ul>
          <p>
            切换方式：在 opencode 里执行 <code>/swarm-mode</code> 命令选择前台或后台，即时生效（无需重启）。
            也可编辑全局配置 <code>~/.config/opencode/agent-swarm.json</code> 的 <code>executionMode</code> 字段。
          </p>
          <h3>监控模式（前台会话实时同步）</h3>
          <p>
            开启后（默认开启），你在 opencode TUI 里与 agent 的<b>日常对话</b>会按轮次实时同步到网页中枢：
            每一次提问、agent 的思考、工具调用、最终回答，以及权限请求/AI 提问，都会以独立「轮次」出现在
            中枢时间线里，与 A2A 任务轮混排显示。你可以在网页上远程围观同事屏幕上的对话过程、回溯任意一轮历史
            （中枢时间线上滚逐轮加载），监控轮次的权限请求同样可以在网页上远程应答。
          </p>
          <ul>
            <li><b>只监控前台会话</b>——后台任务会话不经过此通道，不会重复上报；中枢下发的任务轮也自动去重</li>
            <li><b>开关</b>：TUI 内执行 <code>/swarm-monitor</code> 即时切换；默认开启</li>
            <li><b>归档</b>：每轮对话作为一条 <code>[monitor]</code> 记录进入「调用记录」页（按工作区筛选查看），与 A2A 任务记录并列</li>
          </ul>
          <h3>心跳与在线状态</h3>
          <p>
            插件每 30 秒心跳一次并上报当前会话信息。
            在线状态可在「工作区」页实时查看。
          </p>
        </section>

        <section id="doc-commands" className="docs-section">
          <h2>命令</h2>
          <p>
            安装插件后，agent 对话里可以使用一组 <code>/swarm-*</code> 命令（TUI 内输入，
            静默执行 + toast 反馈）。它们是 MCP 工具的快捷方式，不用记工具参数。
          </p>
          <table>
            <thead><tr><th>命令</th><th>说明</th></tr></thead>
            <tbody>
              <tr>
                <td><code>/swarm-add</code></td>
                <td>注册当前目录为工作区。agent 会分析项目生成用途/能力描述，调 <code>workspace_add</code>，并把工作区 ID 写入项目根 <code>.agent_swarm/workspace.md</code></td>
              </tr>
              <tr>
                <td><code>/swarm-remove</code></td>
                <td>把当前工作区从虫群移除（工作区在线时需先禁用，等心跳过期后才能删）</td>
              </tr>
              <tr>
                <td><code>/swarm-enable</code></td>
                <td>启用当前工作区（恢复可见、参与任务派发）</td>
              </tr>
              <tr>
                <td><code>/swarm-disable</code></td>
                <td>禁用当前工作区（不可见、不再接收任务）</td>
              </tr>
              <tr>
                <td><code>/swarm-mode</code></td>
                <td>切换任务执行模式：前台注入（foreground）或后台会话（background），即时生效（仅 opencode）</td>
              </tr>
              <tr>
                <td><code>/swarm-monitor</code></td>
                <td>切换前台会话实时监控：开启后你在 TUI 里的日常对话（提问/思考/工具/回答）会实时同步到网页中枢，即时生效（仅 opencode）</td>
              </tr>
            </tbody>
          </table>
          <h3>各 agent 支持情况</h3>
          <table>
            <thead><tr><th>能力</th><th>opencode</th><th>claude code</th></tr></thead>
            <tbody>
              <tr><td>注册 / 保活 / 启停管理</td><td>✅</td><td>✅</td></tr>
              <tr><td><code>/swarm-*</code> 命令</td><td>✅</td><td>✅（不含 /swarm-mode、/swarm-monitor）</td></tr>
              <tr><td>前台注入（任务进入当前会话）</td><td>✅</td><td>—</td></tr>
              <tr><td>后台会话（独立会话静默执行）</td><td>✅</td><td>✅</td></tr>
              <tr><td>前台会话监控（TUI 对话同步中枢）</td><td>✅</td><td>—</td></tr>
              <tr><td>权限 / 提问实时应答（input-required）</td><td>✅</td><td>—</td></tr>
            </tbody>
          </table>
        </section>

        <section id="doc-mcp" className="docs-section">
          <h2>MCP 工具</h2>
          <p>
            接入后，你的 agent 会获得下面这组 MCP 工具，直接在对话里让它用即可
            （如「用 list_workspaces 看看现在有哪些工作区在线」）。
          </p>
          <table>
            <thead><tr><th>工具</th><th>说明</th></tr></thead>
            <tbody>
              <tr><td><code>workspace_add</code></td><td>注册当前目录为工作区，返回 ID 并写入 .agent_swarm/workspace.md</td></tr>
              <tr><td><code>workspace_remove</code></td><td>移除自己的工作区（仅离线可删）</td></tr>
              <tr><td><code>workspace_enable</code> / <code>workspace_disable</code></td><td>启用 / 禁用工作区</td></tr>
              <tr><td><code>heartbeat</code></td><td>心跳保活，上报当前会话信息（插件自动调用）</td></tr>
              <tr><td><code>update_info</code> / <code>update_notes</code></td><td>更新用途/能力描述、备注</td></tr>
              <tr><td><code>list_workspaces</code></td><td>列出可见工作区（默认仅在线）</td></tr>
              <tr><td><code>a2a_call</code></td><td>A2A 协议给其他 agent 发任务（支持内部工作区与外部 A2A agent 端点）</td></tr>
              <tr><td><code>a2a_task</code></td><td>查询 A2A 任务状态与结果</td></tr>
            </tbody>
          </table>
          <p>
            上表的 <code>/swarm-*</code> 命令（见「命令」章节）就是这些工具的快捷方式。
          </p>
        </section>

        <section id="doc-web" className="docs-section">
          <h2>Web 管理</h2>
          <p>
            登录后，顶栏可以进入三个管理页面，日常操作都在网页上完成，不需要记任何命令。
          </p>
          <h3>中枢</h3>
          <p>
            在网页上直接指挥 agent。选择一个在线工作区，输入指令发送，时间线会实时滚动
            agent 的思考过程、工具调用与最终答复。agent 请求权限或向你提问时，直接在时间线里点按钮应答。
            时间线历史持久化保存，刷新页面不丢；点 <code>clear</code> 清空视图，鼠标上滚逐轮加载更早的对话，
            右下角的悬浮按钮可随时跳回最新消息。开启监控模式（<code>/swarm-monitor</code>，默认开）后，
            你在 TUI 里的日常对话也会实时出现在这里。
          </p>
          <h3>工作区</h3>
          <p>
            所有已注册工作区的看板：在线状态（30 秒心跳，离线显示最后心跳时间）、
            agent 类型、路径与用途说明。可以启用/禁用工作区（禁用后不参与任务派发）、
            删除离线工作区，支持按名称、路径、用途搜索。
          </p>
          <h3>调用记录</h3>
          <p>
            每一次任务派发与每一轮被监控的 TUI 对话的流水账：发起方、目标、指令内容、状态与结果
            （markdown 渲染）。按工作区筛选查看（记住上次选择，cookie 记忆 30 天）：
            跨 agent 调用、网页中枢指令与 <code>[monitor]</code> 监控轮次都在这里，
            已结束的记录可单条删除，也可一键清空该工作区的全部记录。
          </p>
        </section>

        <section id="doc-faq" className="docs-section">
          <h2>FAQ</h2>
          <h3>权限请求和 AI 提问怎么处理？</h3>
          <p>
            agent 执行中需要授权（如运行命令、写文件）或主动向你提问时，任务进入 <code>input-required</code> 状态：
            目标端的 TUI 会弹出选择框，同时网页中枢时间线出现<b>权限/提问卡片</b>，直接点按钮应答（允许一次 /
            始终允许 / 拒绝，或点选问题选项），agent 立刻继续执行——人和网页谁先响应都可以，另一边会看到结果。
            监控轮次的权限同样支持网页远程应答。注意：后台会话无人值守，权限全自动批准，不走此流程。
          </p>
          <h3>任务会出现在对方屏幕上吗？</h3>
          <p>
            取决于目标工作区的执行模式。前台模式下会：任务直接进入对方当前 TUI 会话并弹 toast 通知，实时可见。
            后台模式下不会：任务在独立会话静默执行，网页中枢里同样能实时观看过程。
            用 <code>/swarm-mode</code> 切换。
          </p>
          <h3>支持哪些 AI 工具？</h3>
          <p>
            我们基于开放协议（MCP + A2A）设计，目标是让<b>所有兼容的 agent 客户端</b>都能加入虫群。
            目前 opencode 全功能支持；claude code 支持注册管理与后台会话任务执行，前台注入暂不支持
            （见「命令」章节的支持情况表）。其它客户端会逐步支持。
          </p>
          <h3>claude 工作区能执行任务吗？</h3>
          <p>
            能，但目前仅限<b>后台会话</b>方式：任务在独立会话静默执行，结果自动回传（网页中枢可实时观看）。
            前台注入（任务进入你正在看的会话）还在规划中。
          </p>
          <h3>安装后 agent 没出现 / 收不到任务？</h3>
          <p>
            重启 opencode 了吗？插件在会话启动时加载，运行中的会话持有旧代码。
            查看 <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code> 可以看到
            心跳与任务领取日志；claude 则查看 <code>~/.claude/agent-swarm/keepalive.log</code>。
          </p>
          <h3>API Key 忘了 / 想换？</h3>
          <p>
            点击顶部用户名进入「账号 → API Key」，随时查看（默认打码）、复制或重置。
            重置后旧 Key 立即失效，已接入的 agent 需要重新安装或更新配置。
          </p>
          <h3>安全吗？</h3>
          <p>
            所有请求都经过鉴权。跨 agent 任务会注入目标工作区的会话——
            只把你信任的机器接入虫群。
          </p>
        </section>
      </article>
    </div>
  )
}

// ---------------- 中枢（nexus，A2A 协议） ----------------

/** 服务端 WS 推来的 A2A 事件（status-update / artifact-update，camelCase） */
type A2aEvent = {
  taskId: string
  contextId: string
  kind: "status-update" | "artifact-update"
  status?: {
    state: string
    message?: A2aMessage | null
  }
  artifact?: {
    artifactId: string
    name?: string
    parts: Array<{ kind: string; text?: string; data?: Record<string, unknown> }>
  }
  lastChunk?: boolean
  metadata?: Record<string, unknown>
}

type A2aMessage = {
  role: string
  parts: Array<{ kind: string; text?: string; data?: Record<string, unknown> }>
  messageId?: string
  taskId?: string
  contextId?: string
}

/** 渲染用 timeline 条目 */
interface TimelineItem {
  key: string
  kind: "user" | "text" | "reasoning" | "tool" | "permission" | "question" | "idle" | "error"
  text: string
  tool?: string
  state?: string
  output?: string
  request_id?: string
  /** 权限/提问所属的 A2A 任务 ID（应答回传用） */
  task_id?: string
  permission?: string
  options?: Array<{ label: string; value: string }>
  answered?: string
  time: number
}

/** 从工具入参提取可展示命令（bash 类） */
function toolCommand(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const c = input.command ?? input.cmd ?? input.command_line ?? input.description
  return typeof c === "string" ? c : JSON.stringify(input)
}

/** 自绘下拉：选项内可嵌 agent 图标（原生 option 不支持 SVG） */
function NexusWorkspaceSelect({ list, value, onChange }: {
  list: Workspace[]
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = list.find((w) => w.id === value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  return (
    <div className="nexus-select-wrap" ref={ref}>
      <button type="button" className="nexus-select-btn" onClick={() => setOpen((o) => !o)}>
        {current ? (
          <>
            <AgentTypeIcon type={current.agent_type} />
            <span>{current.name}</span>
          </>
        ) : (
          <span className="nexus-select-placeholder">选择工作区…</span>
        )}
        <svg className="nexus-select-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="nexus-select-menu">
          {list.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`nexus-select-item${w.id === value ? " selected" : ""}`}
              onClick={() => { onChange(w.id); setOpen(false) }}
            >
              <AgentTypeIcon type={w.agent_type} />
              <span className="nexus-select-item-name">{w.name}</span>
              <span className="nexus-select-item-path">{w.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NexusPage({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Workspace[]>([])
  const [selected, setSelected] = useState<string>(() => {
    // 恢复上次选中的工作区（cookie 记录，30 天有效）
    const m = document.cookie.match(/(?:^|;\s*)swarm_nexus_ws=([^;]*)/)
    try { return m ? decodeURIComponent(m[1]) : "" } catch { return "" }
  })

  // 选中变化时写入 cookie
  useEffect(() => {
    if (selected) {
      document.cookie = `swarm_nexus_ws=${encodeURIComponent(selected)}; max-age=${60 * 60 * 24 * 30}; path=/; SameSite=Lax`
    }
  }, [selected])

  const [pluginOnline, setPluginOnline] = useState(false)
  const [items, setItems] = useState<TimelineItem[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  /** 任务状态表：taskId → 最新状态（completed/input-required 等判定用） */
  const taskStates = useRef<Map<string, string>>(new Map())
  /** 各工作区最后下发的 taskId（busy 解锁匹配键，按工作区隔离——
   *  曾是全局单值：A 区任务未完切到 B 区，busy 卡死输入框且误显示 working） */
  const lastSentTask = useRef<Map<string, string>>(new Map())
  /** 向上分页：已到最早一轮（true 后不再请求） */
  const [noMoreRounds, setNoMoreRounds] = useState(false)
  /** 已加载事件的最小 id（分页游标；0 = 还没加载过任何轮） */
  const minEventId = useRef(0)

  const refresh = useCallback(async () => {
    try { setList(await api.workspaces()) } catch { /* 静默 */ }
  }, [])
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t) }, [refresh])

  const onlineList = list.filter((w) => w.status === "online")

  // 选中工作区时建立 WS 订阅
  useEffect(() => {
    setItems([])
    setPluginOnline(false)
    setNoMoreRounds(false)
    minEventId.current = 0
    followBottom.current = true
    setBusy(false) // busy 按工作区隔离：切走时清掉（B 区不该继承 A 区的 working 态）
    // 切回时按该工作区最后下发任务的实际状态恢复 busy（taskStates 是全局表，不随切换清空）
    {
      const lastTask = lastSentTask.current.get(selected)
      const st = lastTask ? taskStates.current.get(lastTask) : undefined
      if (lastTask && (st === "working" || st === "queued" || st === "input-required")) setBusy(true)
    }
    if (!selected) return
    const token = localStorage.getItem("swarm_token") ?? ""
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${proto}//${location.host}/ws/nexus`)
    wsRef.current = ws
    let helloDone = false

    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token }))
    ws.onmessage = (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch { return }
      switch (msg.type) {
        case "hello_ok":
          helloDone = true
          ws.send(JSON.stringify({ type: "subscribe", workspace_id: selected }))
          break
        case "hello_err":
          toast("WS 鉴权失败，请重新登录")
          break
        case "subscribed":
          setPluginOnline(!!msg.plugin_online)
          // 服务端回放最新一轮（更早的轮上滚分页拉取）
          minEventId.current = Number(msg.first_id ?? 0) // 分页游标：首次上滚从本轮之前开始
          if (Array.isArray(msg.history) && msg.history.length) {
            setItems([])
            for (const evt of msg.history as (A2aEvent | Record<string, unknown>)[]) {
              if (evt && typeof evt === "object" && "kind" in evt) applyA2aEvent(evt as A2aEvent)
              else applyMonitorEvent((evt ?? {}) as Record<string, unknown>)
            }
          }
          break
        case "event":
          applyA2aEvent(msg.payload as A2aEvent)
          break
        case "monitor":
          applyMonitorEvent((msg.payload ?? {}) as Record<string, unknown>)
          break
        case "task":
          // 任务快照：更新状态表（artifact 已随事件渲染）
          {
            const t = msg.task as { id: string; status: string }
            if (t?.id) taskStates.current.set(t.id, t.status)
            if (t?.status === "completed" || t?.status === "failed" || t?.status === "canceled") {
              // 本 WS 只收当前选中工作区的事件；终态 = 解锁该工作区的 busy
              if (t.id === lastSentTask.current.get(selected)) setBusy(false)
            }
          }
          break
      }
    }
    ws.onclose = () => { if (!helloDone) setTimeout(() => setSelected((s) => (s === selected ? s : s)), 0) }

    return () => { ws.close(); wsRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  /** metadata.nexus 标注的 opencode 细节事件 */
  function nxMeta(evt: A2aEvent): Record<string, unknown> {
    return evt.metadata?.nexus ? (evt.metadata as Record<string, unknown>) : {}
  }

  /** A2A 事件 → 渲染条目（合并同 part_id / call_id 的流式更新） */
  function applyA2aEvent(evt: A2aEvent) {
    if (evt.kind === "artifact-update") {
      const text = (evt.artifact?.parts ?? []).map((p) => p.text ?? "").join("\n")
      if (!text) return
      setItems((prev) => {
        // 去重：artifact 即最终 assistant 文本，与流式最后一条 text 条目内容相同，
        // 保留流式条目即可，不再重复渲染 artifact 条目
        if (prev.some((it) => it.kind === "text" && it.text === text)) return prev
        const key = `art-${evt.artifact?.artifactId ?? evt.taskId}`
        const i = prev.findIndex((it) => it.key === key)
        const entry: TimelineItem = { key, kind: "text", text, time: Date.now() }
        if (i >= 0) prev[i] = entry
        else prev.push(entry)
        return [...prev]
      })
      return
    }
    const state = evt.status?.state ?? ""
    taskStates.current.set(evt.taskId, state)
    const meta = nxMeta(evt)
    if (meta.nexus === "tool") {
      const key = `tool-${meta.call_id}`
      const cmd = toolCommand(meta.input as Record<string, unknown> | undefined)
      const entry: TimelineItem = {
        key,
        kind: "tool",
        text: cmd,
        tool: String(meta.tool ?? ""),
        state: String(meta.tool_state ?? "running"),
        output: typeof meta.output === "string" ? meta.output : undefined,
        time: Date.now(),
      }
      setItems((prev) => {
        const next = [...prev]
        const i = next.findIndex((it) => it.key === key)
        if (i >= 0) next[i] = entry
        else next.push(entry)
        return next
      })
      return
    }
    if (meta.nexus === "text" || meta.nexus === "reasoning") {
      const partId = String(meta.part_id ?? "")
      const key = `${meta.nexus === "reasoning" ? "r" : "t"}-${partId}`
      const kind = meta.nexus === "reasoning" ? "reasoning" : "text"
      // mode: "append"=增量 delta（claude stream-json）→ 拼接累积；
      //       "replace"/缺省=全量快照（opencode part）→ 覆盖
      const appendMode = meta.mode === "append"
      setItems((prev) => {
        const next = [...prev]
        const i = next.findIndex((it) => it.key === key)
        const incoming = String(meta.text ?? "")
        if (i >= 0) {
          const merged = appendMode ? (next[i].text ?? "") + incoming : incoming
          next[i] = { ...next[i], text: merged, time: Date.now() }
        } else {
          next.push({ key, kind, text: incoming, time: Date.now() })
        }
        return next
      })
      return
    }
    // input-required：权限/提问（status.message.parts[0].data）
    if (state === "input-required") {
      const data = evt.status?.message?.parts?.find((p) => p.kind === "data")?.data as Record<string, unknown> | undefined
      const type = String(data?.type ?? "")
      const requestId = String(data?.requestId ?? "")
      if (type === "permission" && requestId) {
        const key = `perm-${requestId}`
        setItems((prev) => {
          if (prev.some((it) => it.key === key)) return prev
          return [
            ...prev,
            {
              key,
              kind: "permission",
              text: String(data?.title ?? ""),
              permission: String(data?.permission ?? "unknown"),
              request_id: requestId,
              task_id: evt.taskId,
              time: Date.now(),
            },
          ]
        })
        return
      }
      if (type === "question" && requestId) {
        const key = `ques-${requestId}`
        const options = (Array.isArray(data?.options) ? data.options : []) as Array<{ label: string; value: string }>
        setItems((prev) => {
          if (prev.some((it) => it.key === key)) return prev
          return [
            ...prev,
            {
              key,
              kind: "question",
              text: String(data?.question ?? "请选择"),
              options,
              request_id: requestId,
              task_id: evt.taskId,
              time: Date.now(),
            },
          ]
        })
        return
      }
    }
    if (state === "completed") {
      setBusy(false)
      setItems((prev) => [
        ...prev,
        { key: `idle-${evt.taskId}-${prev.length}`, kind: "idle", text: "已完成", time: Date.now() },
      ])
      return
    }
    if (state === "failed" || state === "canceled") {
      setBusy(false)
      const errText = evt.status?.message?.parts?.find((p) => p.kind === "text")?.text ?? state
      setItems((prev) => [
        ...prev,
        { key: `err-${evt.taskId}-${prev.length}`, kind: "error", text: errText, time: Date.now() },
      ])
      return
    }
    // working + status.message(role=user)：任务指令回显（历史回放时补用户消息）
    if (state === "working" && evt.status?.message?.role === "user") {
      const text = evt.status.message.parts?.find((p) => p.kind === "text")?.text ?? ""
      const meta2 = evt.metadata as Record<string, unknown> | undefined
      if (text) {
        setItems((prev) => {
          const key = `u-${evt.taskId}`
          if (prev.some((it) => it.key === key)) return prev
          // 去重：send() 本地回显已插过同内容条目（u-local-*）→ 收到服务端事件时
          // 删掉本地条目、替换为以 taskId 为 key 的正式条目
          const localIdx = prev.findIndex((it) => it.kind === "user" && it.text === text && it.key.startsWith("u-local-"))
          const entry: TimelineItem = { key, kind: "user", text, time: Date.now() }
          if (localIdx >= 0) {
            const next = [...prev]
            next[localIdx] = entry
            return next
          }
          return [...prev, entry]
        })
        if (meta2?.replied === undefined) setBusy(true)
      }
    }
  }

  /** 前台监控事件（{"type":"monitor"} payload）→ 渲染条目。
   *  形状 {roundKey, sessionId, type, ...}：复用 A2A 条目渲染，key 加 roundKey 前缀防串轮。 */
  function applyMonitorEvent(p: Record<string, unknown>) {
    const round = String(p.roundKey ?? "")
    const mtype = String(p.type ?? "")
    if (!round || !mtype) return
    taskStates.current.set(round, mtype === "idle" ? "completed" : "working")
    if (mtype === "user") {
      const key = `u-${round}`
      setItems((prev) => {
        if (prev.some((it) => it.key === key)) return prev
        return [...prev, { key, kind: "user", text: String(p.text ?? ""), time: Date.now() }]
      })
      return
    }
    if (mtype === "user-text") {
      // 提问文本补拉：更新已存在的 user 条目（开轮时文本为空）
      const key = `u-${round}`
      setItems((prev) => prev.map((it) => (it.key === key && !it.text ? { ...it, text: String(p.text ?? "") } : it)))
      return
    }
    if (mtype === "tool") {
      const key = `tool-${p.callId ?? p.call_id ?? `${round}-${p.tool}`}`
      const entry: TimelineItem = {
        key,
        kind: "tool",
        text: toolCommand(p.input as Record<string, unknown> | undefined),
        tool: String(p.tool ?? ""),
        state: String(p.toolState ?? "running"),
        output: typeof p.output === "string" ? p.output : undefined,
        time: Date.now(),
      }
      setItems((prev) => {
        const next = [...prev]
        const i = next.findIndex((it) => it.key === key)
        if (i >= 0) next[i] = entry
        else next.push(entry)
        // 同轮出现【新的 running 工具】= agent 已越过权限等待（多半在 TUI 里选过了）：
        // 把该轮未应答的 permission/question 条目自动标记，避免残留可点按钮。
        // 只认 running 态——completed 是等待期此前工具的收尾快照，不能作为"已越过"的证据。
        if (entry.state !== "running") return next
        return next.map((it) =>
          !it.answered && it.task_id === round && (it.kind === "permission" || it.kind === "question")
            ? { ...it, answered: "TUI 已处理" }
            : it,
        )
      })
      return
    }
    if (mtype === "text" || mtype === "reasoning") {
      const partId = String(p.partId ?? p.part_id ?? "")
      const key = `${mtype === "reasoning" ? "r" : "t"}-${partId || round}`
      const kind = mtype === "reasoning" ? "reasoning" : "text"
      setItems((prev) => {
        const next = [...prev]
        const i = next.findIndex((it) => it.key === key)
        const incoming = String(p.text ?? "")
        if (i >= 0) next[i] = { ...next[i], text: incoming, time: Date.now() } // replace 全量快照
        else next.push({ key, kind, text: incoming, time: Date.now() })
        return next
      })
      return
    }
    if (mtype === "permission" || mtype === "question") {
      const requestId = String(p.requestId ?? "")
      if (!requestId) return
      const key = mtype === "permission" ? `perm-${requestId}` : `ques-${requestId}`
      setItems((prev) => {
        if (prev.some((it) => it.key === key)) return prev
        return [
          ...prev,
          mtype === "permission"
            ? {
                key,
                kind: "permission" as const,
                text: String(p.title ?? ""),
                permission: String(p.permission ?? "unknown"),
                request_id: requestId,
                task_id: round, // 监控轮：replyTask 的 task_id = roundKey
                time: Date.now(),
              }
            : {
                key,
                kind: "question" as const,
                text: String(p.question ?? "请选择"),
                options: (Array.isArray(p.options) ? p.options : []) as Array<{ label: string; value: string }>,
                request_id: requestId,
                task_id: round,
                time: Date.now(),
              },
        ]
      })
      return
    }
    if (mtype === "idle") {
      setItems((prev) => {
        const key = `idle-${round}`
        if (prev.some((it) => it.key === key)) return prev
        return [...prev, { key, kind: "idle", text: "已完成", time: Date.now() }]
      })
    }
  }

  // 自动滚到底部，仅当视口本来就在底部附近（用户没有上翻看历史时）。
  // 上翻阅读时实时事件不再拽走视口（这就是"回头原来的消息不见了"的体感来源之一）。
  const prependRef = useRef(false)
  const followBottom = useRef(true)
  useEffect(() => {
    if (prependRef.current) {
      prependRef.current = false
      return
    }
    const el = timelineRef.current
    if (!el || !followBottom.current) return
    el.scrollTo({ top: el.scrollHeight })
  }, [items])

  const send = () => {
    const text = input.trim()
    if (!text || !selected || busy) return
    if (!pluginOnline) { toast("目标工作区插件不在线"); return }
    setBusy(true)
    setInput("")
    // 本地先回显用户消息（服务端 working 事件里也会带，去重 key 一致）
    setItems((prev) => prev.some((it) => it.key === `u-pending-${prev.length}`) ? prev : [
      ...prev,
      { key: `u-local-${Date.now()}`, kind: "user", text, time: Date.now() },
    ])
    api.sendTask(selected, text)
      .then((snap) => {
        // 记下任务 ID：终态 task 快照（含 reaper 收割的 failed）解锁 busy 用
        if (snap?.task_id) lastSentTask.current.set(selected, snap.task_id)
      })
      .catch((e: Error) => {
        toast(`下发失败: ${e.message}`)
        setBusy(false)
      })
  }

  const clearHistory = () => {
    // 只清前端时间线（服务端持久化数据保留：上滚可重新加载最新一轮）
    setItems([])
    taskStates.current.clear()
    setNoMoreRounds(false)
    minEventId.current = 0 // 游标归零：上滚重新从最新一轮开始
  }

  /** 向上滚动加载：空时间线 → 拉最新一轮；否则按游标拉上一轮，转换为条目后【前插】。
   *  不清空现有数组（清空重放曾导致"正在看的内容消失"）、不打断 React 渲染，
   *  视口位置由 prepend 后的高度差补偿（onTimelineScroll → requestAnimationFrame）。 */
  const loadingRounds = useRef(false)
  const loadOlderRound = () => {
    if (!selected || loadingRounds.current || noMoreRounds) return
    loadingRounds.current = true
    const firstId = minEventId.current
    api.fetchRounds(selected, firstId)
      .then((rsp) => {
        if (!rsp.events.length) {
          if (items.length === 0) setNoMoreRounds(true)
          return
        }
        if (!rsp.has_more) setNoMoreRounds(true)
        if (rsp.first_id && (!minEventId.current || rsp.first_id < minEventId.current)) {
          minEventId.current = rsp.first_id
        }
        const converted = convertReplayEvents(rsp.events as (A2aEvent | Record<string, unknown>)[])
        // 视口补偿：prepend 会在数组头部插入内容，记录当前高度差，渲染后把 scrollTop 平移同样的量，
        // 用户视口里正在看的内容保持原位（这就是"重新计算滚动条位置"的正确姿势）
        const el = timelineRef.current
        const prevHeight = el?.scrollHeight ?? 0
        prependRef.current = true
        setItems((prev) => {
          const have = new Set(prev.map((it) => it.key))
          return [...converted.filter((it) => !have.has(it.key)), ...prev]
        })
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevHeight
        })
      })
      .catch(() => {})
      .finally(() => { loadingRounds.current = false })
  }

  /** 回放事件序列 → 渲染条目（纯转换，不改状态）。
   *  顺序遍历模拟实时流的 upsert 语义：同 key 后写覆盖先写（条目保留首次出现的位置）。
   *  monitor 载荷与 A2A 事件按形状分发（"kind" in evt）。 */
  function convertReplayEvents(events: (A2aEvent | Record<string, unknown>)[]): TimelineItem[] {
    const byKey = new Map<string, TimelineItem>()
    const order: string[] = []
    const put = (item: TimelineItem) => {
      if (!byKey.has(item.key)) order.push(item.key)
      byKey.set(item.key, item)
    }
    for (const evt of events) {
      if (!evt || typeof evt !== "object") continue
      if ("kind" in evt) convertA2aEvent(evt as A2aEvent, put)
      else convertMonitorEvent(evt as Record<string, unknown>, put, byKey)
    }
    return order.map((k) => byKey.get(k)!)
  }

  /** A2A 事件 → 条目（转换部分，与 applyA2aEvent 的实时分支同规则） */
  function convertA2aEvent(evt: A2aEvent, put: (item: TimelineItem) => void) {
    if (evt.kind === "artifact-update") {
      const text = (evt.artifact?.parts ?? []).map((p) => p.text ?? "").join("\n")
      if (text) put({ key: `art-${evt.artifact?.artifactId ?? evt.taskId}`, kind: "text", text, time: 0 })
      return
    }
    const state = evt.status?.state ?? ""
    const meta = (evt.metadata as Record<string, unknown> | undefined)?.nexus ? (evt.metadata as Record<string, unknown>) : {}
    if (meta.nexus === "tool") {
      put({
        key: `tool-${meta.call_id}`,
        kind: "tool",
        text: toolCommand(meta.input as Record<string, unknown> | undefined),
        tool: String(meta.tool ?? ""),
        state: String(meta.tool_state ?? "running"),
        output: typeof meta.output === "string" ? meta.output : undefined,
        time: 0,
      })
      return
    }
    if (meta.nexus === "text" || meta.nexus === "reasoning") {
      const kind = meta.nexus === "reasoning" ? "reasoning" : "text"
      put({ key: `${meta.nexus === "reasoning" ? "r" : "t"}-${String(meta.part_id ?? "")}`, kind, text: String(meta.text ?? ""), time: 0 })
      return
    }
    if (state === "input-required") {
      const data = evt.status?.message?.parts?.find((p) => p.kind === "data")?.data as Record<string, unknown> | undefined
      const type = String(data?.type ?? "")
      const requestId = String(data?.requestId ?? "")
      if (type === "permission" && requestId) {
        put({ key: `perm-${requestId}`, kind: "permission", text: String(data?.title ?? ""), permission: String(data?.permission ?? "unknown"), request_id: requestId, task_id: evt.taskId, time: 0 })
      } else if (type === "question" && requestId) {
        put({ key: `ques-${requestId}`, kind: "question", text: String(data?.question ?? "请选择"), options: (Array.isArray(data?.options) ? data.options : []) as Array<{ label: string; value: string }>, request_id: requestId, task_id: evt.taskId, time: 0 })
      }
      return
    }
    if (state === "completed") {
      put({ key: `idle-${evt.taskId}`, kind: "idle", text: "已完成", time: 0 })
      return
    }
    if (state === "failed" || state === "canceled") {
      const errText = evt.status?.message?.parts?.find((p) => p.kind === "text")?.text ?? state
      put({ key: `err-${evt.taskId}`, kind: "error", text: errText, time: 0 })
      return
    }
    if (state === "working" && evt.status?.message?.role === "user") {
      const text = evt.status.message.parts?.find((p) => p.kind === "text")?.text ?? ""
      if (text) put({ key: `u-${evt.taskId}`, kind: "user", text, time: 0 })
    }
  }

  /** monitor 载荷 → 条目（转换部分，与 applyMonitorEvent 同规则；user-text 回填内联处理） */
  function convertMonitorEvent(p: Record<string, unknown>, put: (item: TimelineItem) => void, byKey: Map<string, TimelineItem>) {
    const round = String(p.roundKey ?? "")
    const mtype = String(p.type ?? "")
    if (!round || !mtype) return
    if (mtype === "user") {
      put({ key: `u-${round}`, kind: "user", text: String(p.text ?? ""), time: 0 })
      return
    }
    if (mtype === "user-text") {
      // 回填：找到已存在的 user 条目（Map 里先 put 过的），覆盖文本
      const key = `u-${round}`
      const existing = byKey.get(key)
      if (existing && !existing.text) byKey.set(key, { ...existing, text: String(p.text ?? "") })
      return
    }
    if (mtype === "tool") {
      put({
        key: `tool-${p.callId ?? p.call_id ?? `${round}-${p.tool}`}`,
        kind: "tool",
        text: toolCommand(p.input as Record<string, unknown> | undefined),
        tool: String(p.tool ?? ""),
        state: String(p.toolState ?? "running"),
        output: typeof p.output === "string" ? p.output : undefined,
        time: 0,
      })
      return
    }
    if (mtype === "text" || mtype === "reasoning") {
      const partId = String(p.partId ?? p.part_id ?? "")
      const kind = mtype === "reasoning" ? "reasoning" : "text"
      put({ key: `${mtype === "reasoning" ? "r" : "t"}-${partId || round}`, kind, text: String(p.text ?? ""), time: 0 })
      return
    }
    if (mtype === "permission" || mtype === "question") {
      const requestId = String(p.requestId ?? "")
      if (!requestId) return
      const key = mtype === "permission" ? `perm-${requestId}` : `ques-${requestId}`
      put(
        mtype === "permission"
          ? { key, kind: "permission", text: String(p.title ?? ""), permission: String(p.permission ?? "unknown"), request_id: requestId, task_id: round, time: 0 }
          : { key, kind: "question", text: String(p.question ?? "请选择"), options: (Array.isArray(p.options) ? p.options : []) as Array<{ label: string; value: string }>, request_id: requestId, task_id: round, time: 0 },
      )
      return
    }
    if (mtype === "idle") {
      put({ key: `idle-${round}`, kind: "idle", text: "已完成", time: 0 })
    }
  }

  // 时间线滚动：跟踪视口位置（是否贴底 → 自动跟随）；触顶（≤40px）加载更早一轮。
  // 防抖：scroll 事件高频触发，且 prepend 恢复视口的过程也会路过顶部（不设冷却会连环拉取）。
  const scrollCooldown = useRef(0)
  const [showJumpBtn, setShowJumpBtn] = useState(false)
  const onTimelineScroll = () => {
    const el = timelineRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    followBottom.current = fromBottom < 80
    setShowJumpBtn(fromBottom > 200) // 离底超过一屏的 1/3 才出现"回到底部"按钮
    if (el.scrollTop > 40) return
    const now = Date.now()
    if (now - scrollCooldown.current < 800) return
    scrollCooldown.current = now
    loadOlderRound()
  }

  const jumpToBottom = () => {
    const el = timelineRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    followBottom.current = true
    setShowJumpBtn(false)
  }

  const markAnswered = (key: string, answer: string) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, answered: answer } : it)))
  }

  const current = list.find((w) => w.id === selected)

  return (
    <div className="nexus-page">
      <h1 className="page-title">中枢</h1>
      <p className="page-sub">选择一个在线工作区直接下达指令，实时查看 agent 的思考、工具调用与答复。</p>

      <div className="nexus-picker">
        <NexusWorkspaceSelect
          list={onlineList}
          value={selected}
          onChange={setSelected}
        />
        {!onlineList.length && <span className="nexus-empty">暂无在线工作区 — 等待插件心跳上线</span>}
      </div>

      {selected && (
        <div className={`nexus-terminal ${agentToolKind(current?.agent_type) === "opencode" ? "tui" : "claude-tui"}`}>
          <div className="nexus-terminal-head">
            <AgentTypeIcon type={current?.agent_type} inherit />
            <span className="nexus-head-title">{current?.name ?? selected}</span>
            {current?.session_title && (
              <span className="nexus-head-session" title={current.session_title}>{current.session_title}</span>
            )}
            <span className={`nexus-head-status ${pluginOnline ? "on" : "off"}`}>{pluginOnline ? "● online" : "○ offline"}</span>
            <span style={{ flex: 1 }} />
            <button className="nexus-head-clear" title="清空视图（服务端历史保留，上滚可重新加载）" onClick={clearHistory}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18" />
                <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
              clear
            </button>
          </div>
          <div className="nexus-timeline-wrap">
            <div className="nexus-timeline" ref={timelineRef} onScroll={onTimelineScroll}>
              {!items.length && (
                <div className="nexus-waiting">waiting for input — type a command to start</div>
              )}
              {items.map((it) => (
                <TimelineEntrySwitch
                  key={it.key}
                  item={it}
                  agentType={current?.agent_type}
                  onPermissionReply={(reqId, reply) => {
                    api.replyTask(selected, it.task_id ?? "", { type: "permission", request_id: reqId, reply })
                      .catch((e: Error) => toast(`应答失败: ${e.message}`))
                    markAnswered(it.key, reply === "once" ? "一次" : reply === "always" ? "始终" : "拒绝")
                  }}
                  onQuestionReply={(reqId, answers) => {
                    api.replyTask(selected, it.task_id ?? "", { type: "question", request_id: reqId, answers })
                      .catch((e: Error) => toast(`应答失败: ${e.message}`))
                    markAnswered(it.key, answers[0]?.[0] ?? "已选择")
                  }}
                />
              ))}
              {busy && (
                <div className="nexus-statusline">
                  <span className="nexus-spinner">✳</span>
                  <span className="nexus-status-text">Working…</span>
                  <span className="nexus-status-dim">(nexus-web · esc to interrupt in TUI)</span>
                </div>
              )}
            </div>
            {showJumpBtn && (
              <button className="nexus-jump-bottom" title="滚动到底部" onClick={jumpToBottom}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14" />
                  <path d="M19 12l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>
          <div className="nexus-input-row">
            <textarea
              className="nexus-input"
              placeholder={pluginOnline ? "type a command for this agent" : "plugin offline — history only"}
              value={input}
              disabled={!pluginOnline || busy}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value)
                // 自动增高：随内容撑开，超出 max-height 后内部滚动
                e.target.style.height = "auto"
                e.target.style.height = `${e.target.scrollHeight}px`
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button className="nexus-send" onClick={send} disabled={!pluginOnline || busy || !input.trim()}>send ⏎</button>
          </div>
          <div className="nexus-footer">
            <div className="nexus-footer-path" title={current?.session_title ? `会话: ${current.session_title}` : undefined}>
              {current?.path ?? selected}
              {current?.session_title && (
                <>
                  <span className="nexus-footer-dim"> · </span>
                  <span className="nexus-footer-session">{current.session_title}</span>
                </>
              )}
            </div>
            <div className="nexus-footer-main">
              <span className="nexus-footer-key">nexus-web</span>
              <span className="nexus-footer-dim">·</span>
              <span>target: {current?.name ?? selected}</span>
              <span className="nexus-footer-dim">·</span>
              <span>{busy ? "agent running…" : "agent idle"}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** timeline 条目渲染入口：按 agent 类型分发控件
 *  opencode → OpencodeTuiEntry（TUI 黑底终端风格）
 *  其他/未知 → TimelineEntry（气泡风格，兜底默认）
 */
function TimelineEntrySwitch({ item, agentType, onPermissionReply, onQuestionReply }: {
  item: TimelineItem
  agentType: string | null | undefined
  onPermissionReply?: (requestId: string, reply: "once" | "always" | "reject") => void
  onQuestionReply?: (requestId: string, answers: string[][]) => void
}) {
  const kind = agentToolKind(agentType)
  const props = { item, onPermissionReply, onQuestionReply }
  if (kind === "opencode") return <OpencodeTuiEntry {...props} />
  if (kind === "claude") return <ClaudeTuiEntry {...props} />
  return <TimelineEntry {...props} />
}

/** 兜底默认控件：气泡风格（通用，不依赖具体 agent 工具的视觉习惯） */
function TimelineEntry({ item, onPermissionReply, onQuestionReply }: {
  item: TimelineItem
  onPermissionReply?: (requestId: string, reply: "once" | "always" | "reject") => void
  onQuestionReply?: (requestId: string, answers: string[][]) => void
}) {
  if (item.kind === "user") {
    return (
      <div className="tl-item tl-user">
        <div className="tl-role">你</div>
        <div className="tl-bubble">{item.text}</div>
      </div>
    )
  }
  if (item.kind === "idle") {
    return <div className="tl-item tl-idle">✓ {item.text}</div>
  }
  if (item.kind === "error") {
    return (
      <div className="tl-item tl-error">
        <div className="tl-role">错误</div>
        <div className="tl-bubble">{item.text}</div>
      </div>
    )
  }
  if (item.kind === "reasoning") {
    return (
      <details className="tl-item tl-reasoning">
        <summary>思考过程</summary>
        <div className="tl-plain">{item.text}</div>
      </details>
    )
  }
  if (item.kind === "tool") {
    const st = item.state === "completed" ? "✓" : item.state === "error" ? "✗" : "⟳"
    return (
      <div className={`tl-item tl-tool st-${item.state}`}>
        <div className="tl-tool-head">
          <span className="tl-tool-state">{st}</span>
          <span className="tl-tool-name">{item.tool}</span>
        </div>
        {item.text && <pre className="tl-tool-cmd">{item.text}</pre>}
        {item.output?.trim() && <pre className="tl-tool-output">{item.output}</pre>}
      </div>
    )
  }
  if (item.kind === "permission") {
    if (item.answered) {
      return <div className="tl-item tl-idle">✓ 权限已{permAnswerLabel(item.answered!)}</div>
    }
    return (
      <div className="tl-item tl-ask">
        <div className="tl-ask-head">🔐 权限请求：{item.permission}</div>
        {item.text && <div className="tl-ask-body">{item.text}</div>}
        <div className="tl-ask-actions">
          <button className="tl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "once")}>允许一次</button>
          <button className="tl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "always")}>始终允许</button>
          <button className="tl-ask-btn danger" onClick={() => onPermissionReply?.(item.request_id!, "reject")}>拒绝</button>
        </div>
      </div>
    )
  }
  if (item.kind === "question") {
    if (item.answered) {
      return <div className="tl-item tl-idle">✓ {item.answered === "TUI 已处理" ? "已在 TUI 处理" : `已选择：${item.answered}`}</div>
    }
    return (
      <div className="tl-item tl-ask">
        <div className="tl-ask-head">❓ {item.text}</div>
        <div className="tl-ask-actions">
          {(item.options ?? []).map((o) => (
            <button key={o.value} className="tl-ask-btn" onClick={() => onQuestionReply?.(item.request_id!, [[o.value]])}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="tl-item tl-assistant">
      <div className="tl-role">agent</div>
      <div className="tl-bubble md"><Md text={item.text} /></div>
    </div>
  )
}

/** opencode 专用控件：TUI 黑底终端风格（用户指令方框+左蓝竖线 / ● 答复 / Thought for… / 工具方框） */
function OpencodeTuiEntry({ item, onPermissionReply, onQuestionReply }: {
  item: TimelineItem
  onPermissionReply?: (requestId: string, reply: "once" | "always" | "reject") => void
  onQuestionReply?: (requestId: string, answers: string[][]) => void
}) {
  if (item.kind === "user") {
    // 用户指令：方形背景块 + 左侧蓝色竖线（居左，同 TUI）
    return (
      <div className="tl-user-box">
        <div className="tl-user-text">{item.text}</div>
      </div>
    )
  }
  if (item.kind === "idle") {
    return null // 完成标记由底部状态行呈现，不占时间线
  }
  if (item.kind === "error") {
    return (
      <div className="tl-error">
        <span className="tl-error-mark">✗</span>
        <span className="tl-error-text">{item.text}</span>
      </div>
    )
  }
  if (item.kind === "reasoning") {
    return (
      <details className="tl-thought">
        <summary>Thought for a bit (click to expand)</summary>
        <div className="tl-thought-body">{item.text}</div>
      </details>
    )
  }
  if (item.kind === "tool") {
    const running = item.state === "running"
    const glyph = toolGlyph(item.tool ?? "")
    return (
      <div className={`tl-tool-box${running ? " running" : ""}`}>
        <div className="tl-tool-head">
          <span className="tl-tool-glyph">{glyph}</span>
          <span className="tl-tool-name">{item.tool}</span>
          {item.text && <span className="tl-tool-args">{truncateLine(item.text, 96)}</span>}
          {running && <span className="tl-tool-ellipsis">…</span>}
        </div>
        {item.output?.trim() && <TuiToolOutput output={item.output} />}
      </div>
    )
  }
  if (item.kind === "permission") {
    if (item.answered) {
      return (
        <div className="tl-ask-done">
          <span className="tl-ask-glyph">🔐</span>
          权限已{permAnswerLabel(item.answered!)}：{item.permission}
        </div>
      )
    }
    return (
      <div className="tl-ask">
        <div className="tl-ask-head"><span className="tl-ask-glyph">🔐</span> 权限请求：<b>{item.permission}</b></div>
        {item.text && <div className="tl-ask-body">{item.text}</div>}
        <div className="tl-ask-actions">
          <button className="tl-ask-btn primary" onClick={() => onPermissionReply?.(item.request_id!, "once")}>allow once</button>
          <button className="tl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "always")}>always allow</button>
          <button className="tl-ask-btn danger" onClick={() => onPermissionReply?.(item.request_id!, "reject")}>reject</button>
        </div>
      </div>
    )
  }
  if (item.kind === "question") {
    if (item.answered) {
      return (
        <div className="tl-ask-done">
          <span className="tl-ask-glyph">❓</span> {item.answered === "TUI 已处理" ? "已在 TUI 处理" : <>已选择：<b>{item.answered}</b></>}
        </div>
      )
    }
    return (
      <div className="tl-ask">
        <div className="tl-ask-head"><span className="tl-ask-glyph">❓</span> {item.text}</div>
        <div className="tl-ask-actions">
          {(item.options ?? []).map((o) => (
            <button key={o.value} className="tl-ask-btn primary" onClick={() => onQuestionReply?.(item.request_id!, [[o.value]])}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="tl-assistant">
      <span className="tl-dot">●</span>
      <span className="tl-assistant-text md"><Md text={item.text} /></span>
    </div>
  )
}

/** 权限条目应答状态文案：普通应答显示 允许（一次/始终）；TUI 已处理显示中性文案 */
function permAnswerLabel(answered: string): string {
  if (answered === "TUI 已处理") return "已在 TUI 处理"
  return answered === "拒绝" ? "拒绝" : `允许（${answered}）`
}
/** 截断单行文本（工具命令摘要用） */
function truncateLine(s: string, max: number): string {
  const line = s.split("\n")[0]
  return line.length > max ? line.slice(0, max) + "…" : line
}

/** 按工具类型取符号：edit/write → →，read/glob/grep/list → ←，bash → $，其余 ⎇ */
function toolGlyph(tool: string): string {
  const t = tool.toLowerCase()
  if (t === "edit" || t === "write" || t === "patch" || t === "multiedit") return "→"
  if (t === "read" || t === "glob" || t === "grep" || t === "list" || t === "view") return "←"
  if (t === "bash" || t === "shell" || t === "terminal") return "$"
  return "⎇"
}

/** TUI 工具输出：默认限高隐藏，超长时显示 expand 文字（下划线），点击完全展开 */
function TuiToolOutput({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false)
  const LONG = 600 // 超过此长度视为超长输出
  const isLong = output.length > LONG
  return (
    <div className="tl-tool-output-wrap">
      <pre className={`tl-tool-output${isLong ? (expanded ? " expanded" : " clamped") : ""}`}>{output}</pre>
      {isLong && !expanded && (
        <button className="tl-tool-expand" onClick={() => setExpanded(true)}>expand</button>
      )}
    </div>
  )
}

// ---------------- claude 中枢控件（模仿 claude code CLI 时间线） ----------------

/** claude 风格工具行摘要：ToolName(第一参数)。list/read 类不显示内容只给摘要。 */
function claudeToolSummary(item: TimelineItem): string {
  const tool = item.tool ?? "tool"
  const arg = truncateLine(item.text ?? "", 72)
  return arg ? `${tool}(${arg})` : tool
}

/** list/read 类工具的完成摘要（不展示内容，一行 + expand） */
function claudeReadonlySummary(item: TimelineItem): string | null {
  const t = (item.tool ?? "").toLowerCase()
  const n = (item.output ?? "").split("\n").filter((l) => l.trim()).length
  if (["read", "view"].includes(t)) return `Read ${n || 1} line${n === 1 ? "" : "s"}`
  if (["glob", "grep", "list"].includes(t)) return `Found ${n} entr${n === 1 ? "y" : "ies"}`
  return null
}

/** claude 时间线条目：> 用户（左对齐） / ● 大点 agent·tool·thinking / ⎿ 工具输出，无框 */
function ClaudeTuiEntry({ item, onPermissionReply, onQuestionReply }: {
  item: TimelineItem
  onPermissionReply?: (requestId: string, reply: "once" | "always" | "reject") => void
  onQuestionReply?: (requestId: string, answers: string[][]) => void
}) {
  if (item.kind === "user") {
    // 用户输入：左侧 "> " 前缀，无框无竖线
    return (
      <div className="cl-user">
        <span className="cl-prompt">&gt;</span>
        <span className="cl-user-text">{item.text}</span>
      </div>
    )
  }
  if (item.kind === "idle") {
    return null
  }
  if (item.kind === "error") {
    return (
      <div className="cl-entry">
        <span className="cl-dot">●</span>
        <div className="cl-entry-body">
          <span className="cl-error-text">{item.text}</span>
        </div>
      </div>
    )
  }
  if (item.kind === "reasoning") {
    // thinking：● 大点 + "Thought for a bit" 一行，expand 展开全文
    return (
      <details className="cl-entry cl-fold">
        <summary>
          <span className="cl-dot">●</span>
          <span className="cl-fold-label">Thought for a bit</span>
          <span className="cl-expand">expand</span>
        </summary>
        <div className="cl-entry-body">
          <div className="cl-fold-body">{item.text}</div>
        </div>
      </details>
    )
  }
  if (item.kind === "tool") {
    const running = item.state === "running"
    const readonly = claudeReadonlySummary(item)
    const output = item.output?.trim() ?? ""
    // list/read 类：一行摘要（完成后替换为 Found/Read 行），expand 展开完整输出
    if (readonly && !running && output) {
      return (
        <details className="cl-entry cl-fold">
          <summary>
            <span className="cl-dot">●</span>
            <span className="cl-fold-label">{readonly}</span>
            <span className="cl-expand">expand</span>
          </summary>
          <div className="cl-entry-body">
            <div className="cl-tool-cmd">{claudeToolSummary(item)}</div>
            <pre className="cl-hook-output">{output}</pre>
          </div>
        </details>
      )
    }
    // write/bash 等：● Tool(args) + ⎿ 输出（缩进块，超长 expand）
    return (
      <div className="cl-entry">
        <span className="cl-dot">●</span>
        <div className="cl-entry-body">
          <div className="cl-tool-line">
            <span className="cl-tool-name">{running ? claudeToolSummary(item) : claudeToolSummary(item)}</span>
            {running && <span className="cl-ellipsis">…</span>}
          </div>
          {output && <ClaudeHookOutput output={output} />}
        </div>
      </div>
    )
  }
  if (item.kind === "permission") {
    if (item.answered) {
      return (
        <div className="cl-entry cl-done">
          <span className="cl-dot">●</span>
          <div className="cl-entry-body">
            权限已{permAnswerLabel(item.answered!)}：{item.permission}
          </div>
        </div>
      )
    }
    return (
      <div className="cl-entry">
        <span className="cl-dot">●</span>
        <div className="cl-entry-body">
          <div className="cl-ask-head">权限请求：<b>{item.permission}</b></div>
          {item.text && <div className="cl-ask-body">{item.text}</div>}
          <div className="cl-ask-actions">
            <button className="cl-ask-btn primary" onClick={() => onPermissionReply?.(item.request_id!, "once")}>allow once</button>
            <button className="cl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "always")}>always allow</button>
            <button className="cl-ask-btn danger" onClick={() => onPermissionReply?.(item.request_id!, "reject")}>reject</button>
          </div>
        </div>
      </div>
    )
  }
  if (item.kind === "question") {
    if (item.answered) {
      return (
        <div className="cl-entry cl-done">
          <span className="cl-dot">●</span>
          <div className="cl-entry-body">{item.answered === "TUI 已处理" ? "已在 TUI 处理" : <>已选择：<b>{item.answered}</b></>}</div>
        </div>
      )
    }
    return (
      <div className="cl-entry">
        <span className="cl-dot">●</span>
        <div className="cl-entry-body">
          <div className="cl-ask-head">{item.text}</div>
          <div className="cl-ask-actions">
            {(item.options ?? []).map((o) => (
              <button key={o.value} className="cl-ask-btn primary" onClick={() => onQuestionReply?.(item.request_id!, [[o.value]])}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }
  // agent 回答：● 大点 + markdown
  return (
    <div className="cl-entry">
      <span className="cl-dot">●</span>
      <div className="cl-entry-body cl-assistant-md"><Md text={item.text} /></div>
    </div>
  )
}

/** claude ⎿ 输出块：缩进 + ⎿ 前缀，超长限高 + expand */
function ClaudeHookOutput({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = output.split("\n").length > 8 || output.length > 400
  return (
    <div className="cl-hook-wrap">
      <pre className={`cl-hook-output${isLong && !expanded ? " clamped" : ""}`}>{output}</pre>
      {isLong && !expanded && (
        <button className="cl-expand" onClick={() => setExpanded(true)}>expand</button>
      )}
    </div>
  )
}

// ---------------- 工作区 ----------------

function WorkspacesPage({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Workspace[]>([])
  const [detail, setDetail] = useState<Workspace | null>(null)
  const [delTarget, setDelTarget] = useState<Workspace | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")

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

  const q = query.trim().toLowerCase()
  const filtered = q
    ? list.filter((w) => hit(w.id, q) || hit(w.name, q) || hit(w.path, q) || hit(w.purpose, q) || hit(w.capabilities, q) || hit(w.notes, q))
    : list

  return (
    <>
      <h1 className="page-title">工作区</h1>
      <p className="page-sub">你的 agent 工作区及在线状态，每 10s 自动刷新。</p>
      <SearchBox value={query} onChange={setQuery} placeholder="搜索名称 / 路径 / 用途…" />
      <table className="grid ws-grid">
        <thead>
          <tr>
            <th style={{ width: 60 }}></th>
            <th>名称</th>
            <th>状态</th>
            <th>路径</th>
            <th style={{ width: 180 }}>会话</th>
            <th style={{ width: 450 }}>用途</th>
            <th style={{ width: 110 }}></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((w) => (
            <tr key={w.id}>
              <td><Switch on={w.status !== "disabled"} onClick={() => toggle(w)} /></td>
              <td className="strong">
                <AgentTypeIcon type={w.agent_type} />
                <a className="link" onClick={() => setDetail(w)}>{w.name}</a>
              </td>
              <td>
                <span
                  title={w.status === "offline" && w.last_heartbeat ? `最后心跳: ${fmtTime(w.last_heartbeat, "datetime")}` : undefined}
                >
                  <StatusDot status={w.status} />
                </span>
              </td>
              <td title={w.path} style={{ color: "var(--text-weak)", fontSize: 12 }}>{w.path}</td>
              <td title={w.session_title ?? ""} style={{ color: "var(--text-weak)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {w.session_title ? `${w.session_title}` : "-"}
              </td>
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
          {!filtered.length && (
            <tr><td colSpan={7} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
              {q ? `[*] 没有匹配「${query.trim()}」的工作区` : "[*] 暂无工作区 — 在目标机器执行接入页的安装命令"}
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
        <Modal wide title={detail.name} onClose={() => setDetail(null)}>
          <dl className="dl">
            <dt>ID</dt>
            <dd style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-weak)", wordBreak: "break-all" }}>{detail.id}</dd>
            <dt>状态</dt><dd><StatusDot status={detail.status} /></dd>
            <dt>路径</dt><dd>{detail.path}</dd>
            <dt>agent</dt>
            <dd style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AgentTypeIcon type={detail.agent_type} />
              {detail.agent_type || "未知"}
            </dd>
            <dt>用途</dt><dd>{detail.purpose || "-"}</dd>
            <dt>能力</dt><dd>{detail.capabilities || "-"}</dd>
            <dt>备注</dt><dd>{detail.notes || "-"}</dd>
            <dt>所有者</dt><dd>{detail.owner?.username ?? "-"}</dd>
            <dt>当前会话</dt><dd>{detail.session_title || "-"}</dd>
            <dt>最后心跳</dt>
            <dd>{fmtTime(detail.last_heartbeat, "datetime")}</dd>
          </dl>
        </Modal>
      )}
    </>
  )
}

// ---------------- 调用记录 ----------------

/** 发起方显示：渠道标注原样展示（nexus-web / nexus-feishu / ...），互调标 agent */
function callerLabel(r: { caller: { name: string; path: string } | null; external_url?: string | null }): string {
  const c = r.caller
  if (!c?.name) return "-"
  return c.name
}

function CallsPage({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<WorkspaceCall[]>([])
  const [detail, setDetail] = useState<WorkspaceCall | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  // 必选：按工作区筛选；cookie 记忆上次选择（30 天，同中枢 swarm_nexus_ws 惯例）
  const [wsFilter, setWsFilter] = useState(() => {
    const m = document.cookie.match(/(?:^|;\s*)swarm_calls_ws=([^;]*)/)
    try { return m ? decodeURIComponent(m[1]) : "" } catch { return "" }
  })

  useEffect(() => { api.workspaces().then(setWorkspaces).catch(() => {}) }, [])
  useEffect(() => {
    if (wsFilter) {
      document.cookie = `swarm_calls_ws=${encodeURIComponent(wsFilter)}; max-age=${60 * 60 * 24 * 30}; path=/; SameSite=Lax`
    }
  }, [wsFilter])
  const load = useCallback(() => {
    if (!wsFilter) { setList([]); return }
    api.calls(wsFilter).then(setList).catch(() => {})
  }, [wsFilter])
  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  const removeCall = async (id: string) => {
    setDeleting(id)
    try {
      await api.deleteCall(id)
      setList((prev) => prev.filter((c) => c.id !== id))
      if (detail?.id === id) setDetail(null)
      toast("调用记录已删除")
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败")
    } finally {
      setDeleting(null)
    }
  }

  const [clearingAll, setClearingAll] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const clearAll = async () => {
    if (!wsFilter) return
    setClearingAll(true)
    try {
      await api.clearWorkspaceHistory(wsFilter)
      setList([])
      toast("该工作区的全部调用记录已清空")
    } catch (e) {
      toast(e instanceof Error ? e.message : "清空失败")
    } finally {
      setClearingAll(false)
      setConfirmClear(false)
    }
  }

  return (
    <>
      <h1 className="page-title">调用记录</h1>
      <p className="page-sub">A2A 任务调用与前台监控轮次历史（按工作区查看）。</p>
      <div className="nexus-picker" style={{ marginBottom: 12 }}>
        <NexusWorkspaceSelect
          list={workspaces}
          value={wsFilter}
          onChange={setWsFilter}
        />
        <button
          className="calls-clear-btn"
          title="清空该工作区的全部调用记录"
          disabled={!wsFilter || clearingAll}
          onClick={() => setConfirmClear(true)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18" />
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
          clear
        </button>
      </div>
      {wsFilter && (
        <>
          <SearchBox value={query} onChange={setQuery} placeholder="搜索发起方 / 目标 / 指令 / 状态…" />
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 110 }}>时间</th>
                <th style={{ width: 160 }}>发起方</th>
                <th style={{ width: 140 }}>目标</th>
                <th style={{ width: 110 }}>状态</th>
                <th>指令</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {list
                .filter((r) => {
                  const q = query.trim().toLowerCase()
                  if (!q) return true
                  return (
                    hit(r.caller?.name, q) || hit(r.target?.name, q) || hit(r.instruction, q) ||
                    hit(r.status, q) || hit(r.result, q) || hit(r.error, q)
                  )
                })
                .map((r) => (
                <tr key={r.id}>
                  <td style={{ color: "var(--text-weak)", fontSize: 12 }}>{fmtTime(r.created_at, "datetime")}</td>
                  <td>{callerLabel(r)}</td>
                  <td>{r.target?.name ?? "-"}</td>
                  <td><span className={`status-pill ${r.status === "working" || r.status === "queued" ? "accepted" : r.status}`}>{r.status}</span></td>
                  <td><a className="link" onClick={() => setDetail(r)}>{r.monitor ? "[monitor] " : ""}{r.instruction}</a></td>
                  <td>
                    {(r.status === "completed" || r.status === "failed" || r.status === "canceled") && (
                      <Btn
                        variant="icon"
                        size="sm"
                        className="btn-danger-hover"
                        title="删除该调用记录"
                        disabled={deleting === r.id}
                        onClick={() => removeCall(r.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 6h18" />
                          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr><td colSpan={6} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
                  [*] 暂无调用记录
                </td></tr>
              )}
              {list.length > 0 && query.trim() && !list.some((r) => {
                const q = query.trim().toLowerCase()
                return (
                  hit(r.caller?.name, q) || hit(r.target?.name, q) || hit(r.instruction, q) ||
                  hit(r.status, q) || hit(r.result, q) || hit(r.error, q)
                )
              }) && (
                <tr><td colSpan={6} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
                  [*] 没有匹配「{query.trim()}」的调用记录
                </td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
      {!wsFilter && (
        <p style={{ color: "var(--text-weak)", textAlign: "center", padding: 48 }}>
          [*] 请先选择工作区
        </p>
      )}

      {confirmClear && wsFilter && (
        <Modal title="清空调用记录？" onClose={() => setConfirmClear(false)}>
          <p style={{ margin: 0, color: "var(--text-weak)", fontSize: 14 }}>
            将删除工作区 <b>{workspaces.find((w) => w.id === wsFilter)?.name ?? wsFilter}</b> 的全部调用记录
            （含事件与监控轮次），不可恢复。
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>取消</Btn>
            <Btn size="sm" variant="danger" disabled={clearingAll} onClick={clearAll}>确认清空</Btn>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal wide title={`调用 ${detail.id.slice(0, 8)}${detail.monitor ? " (monitor)" : ""}`} onClose={() => setDetail(null)}>
          <dl className="dl">
            <dt>发起方</dt><dd>{callerLabel(detail)}{detail.external_url ? ` (${detail.external_url})` : ""}</dd>
            <dt>目标</dt><dd>{detail.target?.name} ({detail.target?.path})</dd>
            <dt>状态</dt><dd>{detail.status}</dd>
            <dt>发起时间</dt><dd>{fmtTime(detail.created_at, "datetime")}</dd>
            <dt>指令</dt><dd>{detail.instruction}</dd>
            <dt>结果</dt>
            <dd>
              {detail.status === "failed" ? (
                detail.error ?? "-"
              ) : detail.result?.trim() ? (
                <Md text={detail.result} />
              ) : (
                "-"
              )}
            </dd>
          </dl>
        </Modal>
      )}
    </>
  )
}

// PasswordPage 已并入账号页的 PasswordForm（API Key / 修改密码 双 tab）

