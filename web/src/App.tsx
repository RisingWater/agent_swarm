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

export type Page = "home" | "docs" | "workspaces" | "calls" | "account" | "login"

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("swarm_token"))
  const [page, setPage] = useState<Page>("home")
  const { msg, show: toast } = useToast()

  const loggedIn = !!token
  const username = localStorage.getItem("swarm_user")

  // 未登录：可见页面只有 首页/文档，受保护页面跳回首页
  const effectivePage: Page =
    !loggedIn && (page === "workspaces" || page === "calls" || page === "account")
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
          />
        )}
        {effectivePage === "docs" && <DocsPage />}
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
        <Modal title="你的 API Key" onClose={() => { setApiKeyShow(null); onLogin("registered") }}>
          <p style={{ fontSize: 13, color: "var(--text-weak)", marginTop: 0 }}>
            key 可以随时在「账号 → API Key」查看，但请妥善保管：
          </p>
          <div className="keybox" style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>
            {apiKeyShow}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <Btn variant="primary" onClick={() => { setApiKeyShow(null); onLogin("registered") }}>我已保存</Btn>
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

function HomePage({ toast, loggedIn, onGoAccount, onOpenLogin }: { toast: (m: string) => void; loggedIn: boolean; onGoAccount: () => void; onOpenLogin: () => void }) {
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
            <p>所有 agent 操作都是标准 MCP 工具。目前已支持 opencode，claude code、deepseek harness、pi 等支持 MCP 的 agent 客户端会逐步接入。</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="swarm" />
              <h3>跨 agent 任务派发</h3>
            </div>
            <p>一条指令把任务交给另一个工作区的 agent：它会注入对方会话、实时可见、结果自动回传。</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="pulse" />
              <h3>在线状态与心跳</h3>
            </div>
            <p>插件每 30 秒心跳保活，工作区看板实时展示每个 agent 的在线/离线状态。</p>
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
          <li>集中管理所有 AI 工作区的用途说明、备注与在线状态</li>
          <li>回溯每一次跨 agent 调用的指令与结果（调用记录）</li>
        </ul>
      </section>

      {/* 6. 阅读文档 */}
      <section className="home-docs-cta">
        <a className="btn btn-primary docs-btn" href="#/docs">阅读文档 →</a>
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
      // Anthropic Claude 的星芒 logo 抽象
      return (
        <svg {...common}>
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      )
    case "deepseek":
      // 鲸鱼/海豚跃起抽象（Deepseek 招牌意象）
      return (
        <svg {...common}>
          <path d="M3 16c3.5 0 5-2.5 8.5-2.5 3 0 4.5 1.7 7.5 1.7" />
          <path d="M11.5 13.5C12.5 9 16 5.5 21 5c-.5 4.5-3 8.5-7 9.5" />
          <circle cx="17.2" cy="7.2" r="0.6" fill="currentColor" stroke="none" />
          <path d="M4.5 19h15" />
        </svg>
      )
    case "pi":
      // π 字符
      return (
        <svg {...common}>
          <path d="M4.5 8h15" />
          <path d="M7 8c.5 5 1.5 8-1.5 11" />
          <path d="M17 8v8.5c0 1.5 1 2.5 2.5 2.5" />
        </svg>
      )
    case "more":
      // 三点省略
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}

/** 首页"已支持的 agent 工具"图标组 */
function SupportedAgents() {
  const tools: { tool: "opencode" | "claude" | "deepseek" | "pi" | "more"; name: string; supported: boolean }[] = [
    { tool: "opencode", name: "opencode", supported: true },
    { tool: "claude", name: "claude code", supported: false },
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
function FeatureIcon({ kind }: { kind: "mcp" | "swarm" | "pulse" | "shield" }) {
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
  { id: "mcp", title: "MCP 工具" },
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
            <li><b>任何 MCP 客户端可用</b> —— 所有 agent 操作都是标准 MCP 工具，opencode、claude、deepseek 等均可接入</li>
            <li><b>跨 agent 任务派发</b> —— 任务直接注入对方 TUI 会话，实时可见，结果自动回传</li>
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
            插件是 agent 接入虫群的载体，负责心跳保活与接收任务。它跑在每个 agent 工作区的
            opencode 里，安装一次即可。
          </p>
          <h3>安装方式</h3>
          <p>
            在装有 opencode 的目标机器上，执行<b>首页</b>生成的安装命令（已自动带上你的账号 API Key）。
            脚本会自动完成：写入服务配置 → 注册 MCP 端点 → 部署插件 → 拷贝 <code>/swarm-*</code> 命令。
          </p>
          <p>
            <b>重启 opencode 后生效</b>——插件在会话启动时加载，运行中的会话不会热更新。
          </p>
          <h3>验证安装</h3>
          <p>
            重启后打开「工作区」页，约 30 秒内应看到该机器的工作区状态点变绿（online）。
            也可以查看 <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code>，
            里面有启动与心跳日志。
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
            <li>在该项目的 opencode 对话里使用 <code>/swarm-add</code> 命令</li>
            <li>直接让 agent：「帮我把当前目录注册到虫群」（它会调用 <code>workspace_add</code> 工具）</li>
          </ul>
          <p>
            注册时会要求 agent 总结这个目录的用途与能力（显示在「工作区」页，方便其他 agent 了解找谁帮忙）。
            注册成功后，工作区 ID 会写入项目根的 <code>.agent-swarm.md</code> 文件，后续心跳自动带身份。
          </p>
          <h3>管理已注册的工作区</h3>
          <p>
            「工作区」页可以启用/禁用（disabled 的工作区不参与任务派发）、删除离线工作区、修改备注。
            也可以在 agent 里用 <code>workspace_enable</code> / <code>workspace_disable</code> 等工具操作。
          </p>
          <h3>开始协作</h3>
          <p>注册完成后，在 agent 对话里让它派发任务即可：</p>
          <pre><code>{`你: 调用 nas_brain 工作区，查看它最新一次 git 提交
agent: (workspace_call) → 对方 TUI 实时出现任务 → 执行 → 结果自动回传`}</code></pre>
        </section>

        <section id="doc-concepts" className="docs-section">
          <h2>核心概念</h2>
          <h3>工作区（Workspace）</h3>
          <p>
            一个接入虫群的 agent 实例。注册后获得唯一 ID，持久化在项目根 <code>.agent-swarm.md</code> 的
            <code>WORKSPACE_ID:</code> 行。插件每 30 秒心跳保活，超过 90 秒无心跳视为离线；
            禁用（disabled）的工作区不可见、不参与任务派发。
          </p>
          <h3>调用（Workspace Call）</h3>
          <p>
            一次跨 agent 任务派发，状态流转：<code>pending → running → done / failed</code>。
            目标端插件领取任务后<b>前台注入优先</b>——任务直接进入对方正在看的 TUI 会话（弹 toast 通知）；
            对方忙时排队等待（上限 10 分钟），完全无会话时才退回后台会话执行。
            完成后最后一条 assistant 回复自动回传给调用方。
          </p>
          <h3>心跳与在线状态</h3>
          <p>
            插件每 30 秒心跳一次，心跳响应会捎带该工作区的待处理任务。
            在线状态可在「工作区」页实时查看。
          </p>
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
              <tr><td><code>workspace_add</code></td><td>注册当前目录为工作区，返回 ID 并写入 .agent-swarm.md</td></tr>
              <tr><td><code>workspace_remove</code></td><td>移除自己的工作区（仅离线可删）</td></tr>
              <tr><td><code>workspace_enable</code> / <code>workspace_disable</code></td><td>启用 / 禁用工作区</td></tr>
              <tr><td><code>heartbeat</code></td><td>心跳保活，响应捎带待执行任务（插件自动调用）</td></tr>
              <tr><td><code>update_info</code> / <code>update_notes</code></td><td>更新用途/能力描述、备注</td></tr>
              <tr><td><code>list_workspaces</code></td><td>列出可见工作区（默认仅在线）</td></tr>
              <tr><td><code>workspace_call</code></td><td>跨 agent 任务派发（异步，返回 call_id）</td></tr>
              <tr><td><code>workspace_call_status</code></td><td>轮询调用结果</td></tr>
            </tbody>
          </table>
          <p>
            另有 <code>/swarm-add</code> <code>/swarm-remove</code> <code>/swarm-enable</code>
            <code>/swarm-disable</code> 四个 opencode 命令，是上述工具的快捷方式。
          </p>
        </section>

        <section id="doc-faq" className="docs-section">
          <h2>FAQ</h2>
          <h3>任务会出现在对方屏幕上吗？</h3>
          <p>
            会。前台注入优先：任务直接进入对方当前 TUI 会话并弹 toast 通知，实时可见。
            对方正在忙时任务会排队，不会打断。
          </p>
          <h3>支持哪些 AI 工具？</h3>
          <p>
            我们的目标是让<b>所有支持 MCP 的 agent 客户端</b>都能加入虫群。
            目前已支持 opencode，其它 agent 客户端会逐步支持。
          </p>
          <h3>安装后 agent 没出现 / 收不到任务？</h3>
          <p>
            重启 opencode 了吗？插件在会话启动时加载，运行中的会话持有旧代码。
            查看 <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code> 可以看到
            心跳与任务领取日志。
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
          {filtered.map((w) => (
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

// ---------------- 调用记录 ----------------

function CallsPage({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<WorkspaceCall[]>([])
  const [detail, setDetail] = useState<WorkspaceCall | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  const load = useCallback(() => api.calls().then(setList).catch(() => {}), [])
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

  return (
    <>
      <h1 className="page-title">调用记录</h1>
      <p className="page-sub">agent 之间的 workspace_call 调用历史。</p>
      <SearchBox value={query} onChange={setQuery} placeholder="搜索发起方 / 目标 / 指令 / 状态…" />
      <table className="grid">
        <thead>
          <tr>
            <th style={{ width: 110 }}>时间</th>
            <th style={{ width: 140 }}>发起方</th>
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
              <td>{r.caller?.name ?? "-"}</td>
              <td>{r.target?.name ?? "-"}</td>
              <td><span className={`status-pill ${r.status === "running" ? "accepted" : r.status}`}>{r.status}</span></td>
              <td><a className="link" onClick={() => setDetail(r)}>{r.instruction}</a></td>
              <td>
                {(r.status === "done" || r.status === "failed") && (
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

      {detail && (
        <Modal wide title={`调用 ${detail.id.slice(0, 8)}`} onClose={() => setDetail(null)}>
          <dl className="dl">
            <dt>发起方</dt><dd>{detail.caller?.name} ({detail.caller?.path})</dd>
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

