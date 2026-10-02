/** agent_swarm 管理端 —— opencode.ai 风格，纯 React 无 UI 库 */
import { useEffect, useLayoutEffect, useState, useCallback, useRef, type ReactNode } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  api,
  pageOrigin,
  type Workspace,
  type WorkspaceCall,
  type Artifact,
  type User,
  type ChatBindInfo,
  type ChatBindPatch,
  type WeixinStatus,
  type TeamSummary,
  type TeamDetail,
  type TeamInvitations,
  type DiscoveredTeam,
  type SharedWorkspace,
  type Notification,
  type PlannerState,
  type PlannerGoal,
  type PlannerTask,
} from "./api"
import { copyText } from "./copy"
import { AdminPage } from "./AdminPage"
import { useI18n, L, type Lang } from "./i18n"

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
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { t } = useI18n()
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
        <button className="search-clear" title={t("清空", "Clear")} onClick={() => onChange("")}>×</button>
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

export function Btn(props: {
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

export function Modal({
  title,
  onClose,
  children,
  wide,
  headerAction,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  headerAction?: ReactNode
}) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className={`dialog${wide ? " dialog-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3>{title}</h3>
          {headerAction}
        </div>
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

function ShareIcon({ size = 16 }: { size?: number }) {
  // 共享（节点连线）风格图标
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
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

/** 带图标的操作按钮（复用自「调用记录」页的 clear 按钮样式）：图标 + 文字。 */
export function ActionBtn({ icon, children, onClick, disabled, danger, title }: {
  icon?: ReactNode
  children?: ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      className={`action-btn${danger ? " action-btn-danger" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon ? <span className="action-btn-icon">{icon}</span> : null}
      {children != null ? <span className="action-btn-text">{children}</span> : null}
    </button>
  )
}

function TrophyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M17 4h3v2a3 3 0 0 1-3 3" />
      <path d="M7 4H4v2a3 3 0 0 0 3 3" />
    </svg>
  )
}

function NotebookIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v18" />
      <path d="M12 8h5M12 12h5" />
    </svg>
  )
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function BoltIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  )
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function ArchiveIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </svg>
  )
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
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
  const { t } = useI18n()
  return (
    <div className="confirm-pop" onClick={(e) => e.stopPropagation()}>
      {text}
      <div className="actions">
        <Btn size="sm" variant="ghost" onClick={onClose}>{t("取消", "cancel")}</Btn>
        <Btn size="sm" variant="danger" onClick={() => { onOk(); onClose() }}>{t("确认", "confirm")}</Btn>
      </div>
    </div>
  )
}

// ---------------- 站内信 ----------------

function NotificationBell({ onOpenTeam }: { onOpenTeam: (teamId?: string) => void }) {
  const { t } = useI18n()
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Notification[]>([])
  const [loading, setLoading] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const refreshCount = useCallback(() => {
    api.notificationUnreadCount().then((r) => setCount(r.count)).catch(() => {})
  }, [])
  useEffect(() => {
    refreshCount()
    const timer = setInterval(refreshCount, 20_000)
    return () => clearInterval(timer)
  }, [refreshCount])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    setConfirmClear(false)
    if (next) {
      setLoading(true)
      try { setList((await api.notifications()).notifications) } catch { /* ignore */ } finally { setLoading(false) }
      refreshCount()
    }
  }

  const handleClick = async (n: Notification) => {
    if (!n.read) {
      try {
        await api.markNotificationRead(n.id)
        setList((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)))
        setCount((c) => Math.max(0, c - 1))
      } catch { /* ignore */ }
    }
    setOpen(false)
    onOpenTeam(n.team_id || undefined)  // 跳到「团队」页（有 team 时自动打开该团队）
  }

  const readAll = async () => {
    try {
      await api.markAllNotificationsRead()
      setList((prev) => prev.map((x) => ({ ...x, read: true })))
      setCount(0)
    } catch { /* ignore */ }
  }

  const removeOne = async (n: Notification) => {
    try {
      await api.deleteNotification(n.id)
      setList((prev) => prev.filter((x) => x.id !== n.id))
      if (!n.read) setCount((c) => Math.max(0, c - 1))
    } catch { /* ignore */ }
  }

  const removeAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true)  // 二次确认：再点一次才真正清空
      return
    }
    try {
      await api.deleteAllNotifications()
      setList([])
      setCount(0)
    } catch { /* ignore */ }
    setConfirmClear(false)
  }

  return (
    <span className="notif-wrap">
      <a className={`user notif-bell${open ? " active" : ""}`} title={t("站内信", "Notifications")} onClick={toggle}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {count > 0 && <span className="notif-badge">{count > 99 ? "99+" : count}</span>}
      </a>
      {open && (
        <>
          <div className="notif-backdrop" onClick={() => setOpen(false)} />
          <div className="notif-panel">
            <div className="notif-head">
              <b>{t("站内信", "Notifications")}</b>
              <span style={{ display: "inline-flex", gap: 6 }}>
                <Btn size="sm" variant="ghost" disabled={count === 0} onClick={readAll}>{t("全部已读", "Mark all read")}</Btn>
                <Btn size="sm" variant="ghost" disabled={list.length === 0} onClick={removeAll}>
                  {confirmClear ? t("确认删除", "Confirm delete") : t("全部删除", "Delete all")}
                </Btn>
              </span>
            </div>
            {loading ? (
              <p className="notif-empty">{t("加载中…", "Loading…")}</p>
            ) : list.length ? (
              <div className="notif-list">
                {list.map((n) => (
                  <div key={n.id} className={`notif-item${n.read ? "" : " unread"}`} onClick={() => handleClick(n)}>
                    <div className="notif-main">
                      <div className="notif-title">{n.title}</div>
                      {n.body && <div className="notif-body">{n.body}</div>}
                      <div className="notif-time">{fmtTime(n.created_at, "datetime")}</div>
                    </div>
                    <button
                      className="notif-del"
                      title={t("删除该消息", "Delete this message")}
                      onClick={(e) => { e.stopPropagation(); removeOne(n) }}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="notif-empty">{t("暂无消息", "No messages")}</p>
            )}
          </div>
        </>
      )}
    </span>
  )
}

// ---------------- 应用骨架 ----------------

export type Page = "home" | "docs" | "workspaces" | "calls" | "artifacts" | "account" | "nexus" | "teams" | "planner" | "login"

/** 顶栏中英文切换：中 / EN 两段，当前语言高亮。 */
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

export default function App() {
  const { t } = useI18n()
  const { msg, show: toast } = useToast()
  const [token, setToken] = useState(localStorage.getItem("swarm_token"))
  const [page, setPage] = useState<Page>("home")
  const [openTeamId, setOpenTeamId] = useState<string | null>(null)
  // 后台管理：独立 hash 路由（#/admin），独立登录，不进主导航。
  // 注意 hooks 顺序：adminHash 判断必须在全部 hooks 声明之后（条件 return 会破坏 hooks 规则）
  const [adminHash, setAdminHash] = useState(window.location.hash === "#/admin")
  useEffect(() => {
    const onHash = () => setAdminHash(window.location.hash === "#/admin")
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  if (adminHash) return <AdminPage toast={toast} />

  const loggedIn = !!token
  const username = localStorage.getItem("swarm_user")

  // 未登录：可见页面只有 首页/文档，受保护页面跳回首页
  const effectivePage: Page =
    (!loggedIn && (page === "workspaces" || page === "calls" || page === "artifacts" || page === "account" || page === "nexus" || page === "teams" || page === "planner"))
      ? "home"
      : page

  // 切换页面时回到顶部
  const goto = (p: Page) => {
    setPage(p)
    window.scrollTo({ top: 0 })
  }

  // 站内信点击：跳到「团队」页（带 team_id 时自动打开该团队详情）
  const openTeam = (teamId?: string) => {
    setOpenTeamId(teamId ?? null)
    goto("teams")
  }

  return (
    <>
      <header className="topnav">
        <a className="topnav-logo" href="#" onClick={(e) => { e.preventDefault(); goto("home") }} title={t("首页", "Home")}>
          <Logo />
        </a>
        <nav className="topnav-links">
          <a className={effectivePage === "home" ? "active" : ""} onClick={() => goto("home")}>{t("首页", "Home")}</a>
          <a className={effectivePage === "docs" ? "active" : ""} onClick={() => goto("docs")}>{t("文档", "Docs")}</a>
          {loggedIn && (
            <>
              <a className={effectivePage === "nexus" ? "active" : ""} onClick={() => goto("nexus")}>{t("中枢", "Nexus")}</a>
              <a className={effectivePage === "teams" ? "active" : ""} onClick={() => goto("teams")}>{t("团队", "Teams")}</a>
              <a className={effectivePage === "planner" ? "active" : ""} onClick={() => goto("planner")}>{t("规划器", "Planner")}</a>
              <a className={effectivePage === "workspaces" ? "active" : ""} onClick={() => goto("workspaces")}>{t("工作区", "Workspaces")}</a>
              <a className={effectivePage === "calls" ? "active" : ""} onClick={() => goto("calls")}>{t("调用记录", "Calls")}</a>
              <a className={effectivePage === "artifacts" ? "active" : ""} onClick={() => goto("artifacts")}>{t("产物", "Artifacts")}</a>
            </>
          )}
          {loggedIn && <NotificationBell onOpenTeam={openTeam} />}
          {loggedIn ? (
            <a
              className={`user${effectivePage === "account" ? " active" : ""}`}
              title={t("账号：API Key / 修改密码", "Account: API Key / password")}
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
            <a className="user" title={t("登录或注册", "Log in or sign up")} onClick={() => setPage("login")}>{t("登录 / 注册", "Log in / Sign up")}</a>
          )}
          <LangSwitch />
          <a
            className="github-link"
            href="https://github.com/RisingWater/agent_swarm"
            target="_blank"
            rel="noreferrer"
            title={t("GitHub 仓库", "GitHub repository")}
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
              {t("退出", "Log out")}
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
        {effectivePage === "planner" && <PlannerPage toast={toast} />}
        {effectivePage === "teams" && <TeamsPage toast={toast} openTeamId={openTeamId} onConsumeOpenTeam={() => setOpenTeamId(null)} />}
        {effectivePage === "workspaces" && <WorkspacesPage toast={toast} />}
        {effectivePage === "calls" && <CallsPage toast={toast} />}
        {effectivePage === "artifacts" && <ArtifactsPage toast={toast} />}
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
  const { t } = useI18n()
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
          <button role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>{t("登录", "Log in")}</button>
          <button role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>{t("注册", "Sign up")}</button>
        </div>
        <div className="tabpanel">
          <div style={{ display: "grid", gap: 12 }}>
            <input className="field" placeholder={t("用户名（2-32 位）", "Username (2-32 chars)")} value={username} onChange={(e) => setUsername(e.target.value)} />
            <input className="field" type="password" placeholder={t("密码（至少 6 位）", "Password (min 6 chars)")} value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()} />
            {err && <div style={{ color: "#d4494b", fontSize: 12 }}>{err}</div>}
            <button className="btn btn-primary" style={{ justifyContent: "center" }} disabled={loading} onClick={submit}>
              {loading ? t("请稍候…", "Please wait…") : mode === "login" ? t("登录", "Log in") : t("注册", "Sign up")}
            </button>
          </div>
        </div>
      </div>
      {apiKeyShow && (
        <Modal title={t("你的 API Key", "Your API Key")} onClose={() => { setApiKeyShow(null); onLogin(pendingToken) }}>
          <p style={{ fontSize: 13, color: "var(--text-weak)", marginTop: 0 }}>
            {t("key 可以随时在「账号 → API Key」查看，但请妥善保管：", "You can always find this key under Account → API Key, but keep it safe:")}
          </p>
          <div className="keybox" style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>
            {apiKeyShow}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <Btn variant="primary" onClick={() => { setApiKeyShow(null); onLogin(pendingToken) }}>{t("我已保存", "I've saved it")}</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------- 账号（左侧二级菜单：API Key / 修改密码） ----------------

function AccountPage({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<"apikey" | "password" | "chatbinds">("apikey")
  return (
    <div className="subpage">
      <aside className="subpage-toc">
        <p className="section-label">{t("[ 账号 ]", "[ Account ]")}</p>
        <a className={`subpage-item${tab === "apikey" ? " active" : ""}`} onClick={() => setTab("apikey")}>
          API Key
        </a>
        <a className={`subpage-item${tab === "chatbinds" ? " active" : ""}`} onClick={() => setTab("chatbinds")}>
          {t("聊天工具绑定", "Chat bindings")}
        </a>
        <a className={`subpage-item${tab === "password" ? " active" : ""}`} onClick={() => setTab("password")}>
          {t("修改密码", "Change password")}
        </a>
      </aside>
      <div className="subpage-body">
        {tab === "apikey" && <ApiKeyPanel toast={toast} />}
        {tab === "chatbinds" && <ChatBindPanel toast={toast} />}
        {tab === "password" && <PasswordForm toast={toast} />}
      </div>
    </div>
  )
}

/** 飞书品牌图标（官方 SVG，web/public/feishu.svg） */
function FeishuIcon({ size = 18 }: { size?: number }) {
  const { t } = useI18n()
  return (
    <img
      src="/feishu.svg"
      alt={t("飞书", "Feishu")}
      width={size}
      height={size}
      style={{ borderRadius: 5, flexShrink: 0 }}
    />
  )
}

/** 微信品牌图标（官方 SVG，web/public/weixin.svg，绿色） */
function WeixinIcon({ size = 18 }: { size?: number }) {
  const { t } = useI18n()
  return (
    <img
      src="/weixin.svg"
      alt={t("微信", "WeChat")}
      width={size}
      height={size}
      style={{ flexShrink: 0 }}
    />
  )
}

function ChatBindPanel({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
  const [info, setInfo] = useState<ChatBindInfo | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [saving, setSaving] = useState("")

  const refresh = useCallback(() => {
    api.chatBinds().then(setInfo).catch((e) => toast(e.message))
  }, [toast])
  useEffect(() => {
    refresh()
    api.workspaces().then(setWorkspaces).catch(() => {})
  }, [refresh])

  const update = async (chatId: string, patch: ChatBindPatch) => {
    setSaving(chatId)
    try {
      await api.updateChatBind(chatId, patch)
      toast(t("已保存，飞书端会收到通知", "Saved; the Feishu side will be notified"))
      refresh()
    } catch (e: any) {
      toast(e.message)
    } finally {
      setSaving("")
    }
  }

  if (!info) return <p className="section-label">[ loading… ]</p>
  const hasAnyBinding = info.bindings.length > 0
  return (
    <>
      <p className="section-label">{t("[ 聊天工具绑定 ]", "[ Chat bindings ]")}</p>
      {/* 飞书：有绑定显示已连接卡，否则显示未连接卡（列出支持 IM + 如何连接，不再有空文案分支） */}
      {!hasAnyBinding && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px",
          display: "flex", flexDirection: "column", gap: 9, marginBottom: 22,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <FeishuIcon size={18} />
            <b style={{ fontSize: 14 }}>{t("飞书", "Feishu")}</b>
            <span style={{ fontSize: 12, color: "var(--text-weak)", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--border)", display: "inline-block" }} />
              {t("未连接", "Not connected")}
            </span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-weak)", margin: 0 }}>
            <L
              zh={<>在飞书里给机器人发送 <code>/swarm bind as_你的密钥</code> 完成绑定
                （密钥在「API Key」页复制）。绑定后可在聊天里派任务、收时间线直播与完成简报、远程应答权限请求。</>}
              en={<>In Feishu, send the bot <code>/swarm bind as_your_key</code> to bind
                (copy the key from the "API Key" page). Once bound you can dispatch tasks, receive the live timeline and completion briefs, and answer permission requests right in chat.</>}
            />
          </p>
        </div>
      )}
      {info.bindings.map((g) => (
        <div key={g.open_id} style={{ marginBottom: 22 }}>
          {g.chats.map((c) => (
            <div key={c.chat_id} style={{
              border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px",
              marginBottom: 12, display: "flex", flexDirection: "column", gap: 9,
              opacity: saving === c.chat_id ? 0.6 : 1,
            }}>
              {/* 行1：logo + 名字 + 连接状态（飞书绑定即已连接） */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <FeishuIcon size={18} />
                <b style={{ fontSize: 14 }}>{t("飞书", "Feishu")}{g.feishu_name ? ` · ${g.feishu_name}` : ""}</b>
                <span style={{ fontSize: 12, color: "var(--ok, green)", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok, #2ecc71)", display: "inline-block" }} />
                  {t("已连接", "Connected")}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-weak)" }}>
                  {t(`${g.chats.length} 个窗口`, `${g.chats.length} window${g.chats.length > 1 ? "s" : ""}`)}
                </span>
                <span style={{ flex: 1 }} />
                <ConfirmWrap text={t("解绑后所有窗口取消工作区选择，需要重新 /swarm bind 才能使用。确认？",
                  "After unbinding, all windows lose their workspace selection and you must run /swarm bind again. Continue?")} onOk={async () => {
                  try {
                    await api.unbindChatAccount(g.open_id)
                    toast(t("已解绑，飞书窗口会收到通知", "Unbound; the Feishu windows will be notified"))
                    refresh()
                  } catch (e: any) {
                    toast(e.message)
                  }
                }}>
                  <Btn size="sm" variant="danger">{t("🔌 断开连接", "🔌 Disconnect")}</Btn>
                </ConfirmWrap>
              </div>
              {/* 行2：账号标识（飞书 = open_id） */}
              <div style={{ fontSize: 12, color: "var(--text-weak)" }}>
                {t("ID：", "ID: ")}<code>{g.open_id.slice(0, 22)}…</code>
              </div>
              {/* 行3：监控 / 简报 */}
              <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={c.monitor_on}
                    onChange={(e) => update(c.chat_id, { monitor_on: e.target.checked })}
                  />
                  {t("监控模式", "Monitor mode")}{c.monitor_on ? t("（开）", " (on)") : t("（关）", " (off)")}
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={c.brief_on}
                    onChange={(e) => update(c.chat_id, { brief_on: e.target.checked })}
                  />
                  {t("简报模式", "Brief mode")}{c.brief_on ? t("（开）", " (on)") : t("（关）", " (off)")}
                </label>
              </div>
              {/* 行4：所选工作区 */}
              <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {t("所选工作区：", "Selected workspace: ")}
                <NexusWorkspaceSelect
                  list={workspaces.map((w) => ({ id: w.id, name: w.name, path: w.path, agent_type: w.agent_type, owner: null }))}
                  value={c.workspace_id}
                  onChange={(id) => update(c.chat_id, { workspace_id: id })}
                />
              </div>
              {/* 行5：说明文字 */}
              <p style={{ fontSize: 12, color: "var(--text-weak)", margin: 0 }}>
                <L
                  zh={<>监控模式 = TUI 对话按时间线实时同步；简报模式 = 任务完成后推送结果摘要卡。
                    窗口：{c.chat_type === "group" ? "群聊" : "私聊"} <code>{c.chat_id.slice(0, 14)}…</code>。
                    修改会即时生效，飞书窗口会收到变更通知。</>}
                  en={<>Monitor mode = TUI conversations sync live as a timeline; brief mode = push a result summary card when a task finishes.
                    Window: {c.chat_type === "group" ? "Group" : "Direct"} <code>{c.chat_id.slice(0, 14)}…</code>.
                    Changes take effect immediately and the Feishu windows receive a change notification.</>}
                />
              </p>
            </div>
          ))}
        </div>
      ))}
      <WeixinPanel toast={toast} />
    </>
  )
}

/** 微信 ClawBot（扫码登录自己的微信号作为 bot，扫码后微信里出现 ClawBot 会话） */
function WeixinPanel({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
  const [st, setSt] = useState<WeixinStatus | null>(null)
  const [verifyCode, setVerifyCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [errHint, setErrHint] = useState("")  // 上次扫码失败/过期的提示（点重新获取后清除）

  const refresh = useCallback(() => {
    api.weixinStatus().then(setSt).catch(() => setSt(null))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  // 扫码流程中轮询状态（终态后端已清流程，这里兜底切视图 + 记录失败原因）
  useEffect(() => {
    if (!st?.flow || st.flow.status === "confirmed" || st.flow.status === "expired" || st.flow.status === "error") {
      if (st?.flow && (st.flow.status === "expired" || st.flow.status === "error")) {
        setErrHint(st.flow.message)
      }
      return
    }
    const timer = setInterval(() => {
      api.weixinLoginStatus().then((s) => {
        if (s.flow?.status === "expired" || s.flow?.status === "error") {
          setErrHint(s.flow.message)
        } else if (!s.flow && s.logged_in) {
          toast(t("微信 ClawBot 已连接", "WeChat ClawBot connected"))
        }
        setSt(s)
      }).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [st?.flow?.status, st?.flow])

  const start = async () => {
    setBusy(true)
    try {
      setSt(await api.weixinLoginStart())
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }
  const cancel = async () => {
    try { await api.weixinLoginCancel() } catch { /* ignore */ }
    refresh()
  }
  const submitVerify = async () => {
    if (!verifyCode.trim()) return
    try { await api.weixinLoginVerify(verifyCode.trim()); setVerifyCode(""); toast(t("配对码已提交", "Pairing code submitted")) } catch (e: any) { toast(e.message) }
  }
  const logout = async () => {
    try { await api.weixinLogout(); toast(t("已断开微信连接", "WeChat disconnected")); refresh() } catch (e: any) { toast(e.message) }
  }

  const wsList = useWorkspacesForSelect()
  const flow = st?.flow

  return (
    <div>
      {!st?.logged_in && !flow && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px",
          display: "flex", flexDirection: "column", gap: 9, marginBottom: 22,
        }}>
          {/* 行1：logo + 名字 + 未连接灰点 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <WeixinIcon size={18} />
            <b style={{ fontSize: 14 }}>{t("微信 ClawBot", "WeChat ClawBot")}</b>
            <span style={{ fontSize: 12, color: "var(--text-weak)", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--border)", display: "inline-block" }} />
              {t("未连接", "Not connected")}
            </span>
          </div>
          {/* 行2：说明 + 连接方式 */}
          <p style={{ fontSize: 12, color: "var(--text-weak)", margin: 0 }}>
            <L
              zh={<>扫码把<b>你自己的微信号</b>登录为本平台的 ClawBot。登录后微信里会出现一个 ClawBot
                会话：发文字给它即可选择工作区、派任务、收简报、应答 AI 的提问与授权请求。</>}
              en={<>Scan the QR code to log <b>your own WeChat account</b> in as this platform's ClawBot. Once logged in, a ClawBot
                conversation appears in WeChat: send it text to pick a workspace, dispatch tasks, receive briefs and answer the AI's questions and authorization requests.</>}
            />
          </p>
          {errHint && (
            <p style={{ fontSize: 13, color: "var(--danger, #c0392b)", margin: 0 }}>{errHint}</p>
          )}
          <div>
            <Btn size="sm" disabled={busy} onClick={() => { setErrHint(""); start() }}>
              {errHint ? t("重新获取二维码", "Get a new QR code") : busy ? t("获取中…", "Getting…") : t("扫码登录微信", "Log in to WeChat by QR")}
            </Btn>
          </div>
        </div>
      )}

      {flow && flow.status !== "confirmed" && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px",
          display: "flex", flexDirection: "column", gap: 9, marginBottom: 22,
        }}>
          {/* 行1：logo + 名字 + 扫码中状态 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <WeixinIcon size={18} />
            <b style={{ fontSize: 14 }}>{t("微信 ClawBot", "WeChat ClawBot")}</b>
            <span style={{ fontSize: 12, color: "var(--text-weak)", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--border)", display: "inline-block" }} />
              {t("连接中…", "Connecting…")}
            </span>
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
          {flow.qrcode_img ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "#fff", position: "relative" }}>
              <img src={flow.qrcode_img} alt={t("微信登录二维码", "WeChat login QR code")}
                style={{ width: 180, height: 180, display: "block", opacity: flow.status === "scanned" ? 0.2 : 1 }} />
              {flow.status === "scanned" && (
                <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, color: "var(--ok, green)", fontWeight: 600 }}>{t("✓ 已扫码", "✓ Scanned")}</span>
              )}
            </div>
          ) : (
            <div style={{ width: 180, height: 180, border: "1px dashed var(--border)", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-weak)" }}>
              {t("二维码加载中…", "Loading QR code…")}
            </div>
          )}
          <div>
            <p style={{ fontSize: 13 }}>{flow.message}</p>
            {flow.status === "need_verifycode" && (
              <div className="keyrow" style={{ marginTop: 8 }}>
                <input className="field" style={{ maxWidth: 140 }} placeholder={t("数字配对码", "Numeric pairing code")}
                  value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} />
                <Btn size="sm" onClick={submitVerify}>{t("提交", "Submit")}</Btn>
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <Btn size="sm" variant="ghost" onClick={cancel}>{t("取消", "Cancel")}</Btn>
            </div>
          </div>
        </div>
        </div>
      )}

      {st?.logged_in && !flow && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 10, padding: "14px 18px",
          display: "flex", flexDirection: "column", gap: 9, marginBottom: 22,
        }}>
          {/* 行1：logo + 名字 + 连接状态 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <WeixinIcon size={18} />
            <b style={{ fontSize: 14 }}>{t("微信 ClawBot", "WeChat ClawBot")}</b>
            <span style={{ fontSize: 12, color: "var(--ok, green)", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok, #2ecc71)", display: "inline-block" }} />
              {t("已连接", "Connected")}
            </span>
            <span style={{ flex: 1 }} />
            <ConfirmWrap text={t("断开后微信 ClawBot 会话停止工作，需要重新扫码登录。确认？",
              "After disconnecting, the WeChat ClawBot conversation stops working and you must scan again to log in. Continue?")} onOk={logout}>
              <Btn size="sm" variant="danger">{t("🔌 断开连接", "🔌 Disconnect")}</Btn>
            </ConfirmWrap>
          </div>
          {/* 行2：用户名 + user id + 登录时间 */}
          <div style={{ fontSize: 12, color: "var(--text-weak)" }}>
            {t("用户：微信用户", "User: WeChat user")} · <code>{(st.wx_user_id || "").slice(0, 18)}…</code>
            {st.logged_at ? <> · {t("登录于", "logged in at")} {st.logged_at.slice(0, 16).replace("T", " ")}Z</> : null}
          </div>
          {/* 行3：监控 / 简报 */}
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={!!st.monitor_on}
                onChange={async (e) => { try { setSt(await api.weixinSettings({ monitor_on: e.target.checked })) } catch (err: any) { toast(err.message) } }} />
              {t("监控模式", "Monitor mode")}{st.monitor_on ? t("（开）", " (on)") : t("（关）", " (off)")}
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={st.brief_on !== false}
                onChange={async (e) => { try { setSt(await api.weixinSettings({ brief_on: e.target.checked })) } catch (err: any) { toast(err.message) } }} />
              {t("简报模式", "Brief mode")}{st.brief_on !== false ? t("（开）", " (on)") : t("（关）", " (off)")}
            </label>
          </div>
          {/* 行4：所选工作区 */}
          <div style={{ fontSize: 13 }}>
            {t("所选工作区：", "Selected workspace: ")}
            <span style={{ marginLeft: 6 }}>
              <NexusWorkspaceSelect
                list={wsList.map((w) => ({ id: w.id, name: w.name, path: w.path, agent_type: w.agent_type, owner: null }))}
                value={st.workspace_id || ""}
                onChange={async (id) => { try { setSt(await api.weixinSettings({ workspace_id: id })) } catch (err: any) { toast(err.message) } }}
              />
            </span>
          </div>
          {/* 行5：说明文字 */}
          <p style={{ fontSize: 12, color: "var(--text-weak)", margin: 0 }}>
            {t("在微信 ClawBot 会话里也可以用指令管理：/swarm select、/swarm monitor on、/swarm brief off 等（发 help 查看）。微信连接受官方约 24h 有效期限制，失效后会提示重新扫码。",
              "You can also manage it with commands in the WeChat ClawBot conversation: /swarm select, /swarm monitor on, /swarm brief off, etc. (send help). The WeChat connection is limited to about 24h by the official API; when it expires you'll be prompted to scan again.")}
          </p>
        </div>
      )}
    </div>
  )
}

/** 微信面板用的本用户工作区列表（轻量拉取） */
function useWorkspacesForSelect(): Workspace[] {
  const [list, setList] = useState<Workspace[]>([])
  useEffect(() => {
    let alive = true
    api.workspaces().then((r) => { if (alive) setList(r) }).catch(() => {})
    return () => { alive = false }
  }, [])
  return list
}

function ApiKeyPanel({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
  const [me, setMe] = useState<(User & { api_key: string }) | null>(null)
  const [showKey, setShowKey] = useState(false)

  const refresh = useCallback(() => {
    api.me().then(setMe).catch((e) => toast(e.message))
  }, [toast])
  useEffect(() => { refresh() }, [refresh])

  const reset = async () => {
    try {
      await api.resetApiKey()
      toast(t("API Key 已重置", "API Key reset"))
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
        <Btn variant="icon" title={showKey ? t("隐藏", "hide") : t("显示", "show")} onClick={() => setShowKey(!showKey)}>
          <EyeIcon off={!showKey} />
        </Btn>
        <Btn variant="icon" title={t("复制", "copy")} onClick={async () => {
          toast(await copyText(key) ? t("已复制", "Copied") : t("复制失败，请手动选择复制", "Copy failed, please select and copy manually"))
        }}>⧉</Btn>
        <ConfirmWrap text={t("重置后旧 Key 立即失效，所有 agent 将断开连接。确认？",
          "After resetting, the old Key is invalidated immediately and every connected agent is disconnected. Continue?")} onOk={reset}>
          <Btn size="sm" variant="danger">{t("重置", "reset")}</Btn>
        </ConfirmWrap>
      </div>
      <p style={{ marginTop: 12, color: "var(--text-weak)", fontSize: 13 }}>
        {t("安装接入命令在「接入」页生成，会自动带上当前 Key。",
          "The install command is generated on the onboarding page and automatically includes the current Key.")}
      </p>
    </>
  )
}

function PasswordForm({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
  const [username] = useState(localStorage.getItem("swarm_user") ?? "")
  const [oldPwd, setOldPwd] = useState("")
  const [newPwd, setNewPwd] = useState("")
  const [newPwd2, setNewPwd2] = useState("")
  const [loading, setLoading] = useState(false)
  const [show, setShow] = useState(false)

  const submit = async () => {
    if (!oldPwd || !newPwd) return toast(t("请填写完整", "Please fill in all fields"))
    if (newPwd !== newPwd2) return toast(t("两次输入的新密码不一致", "The new passwords do not match"))
    if (newPwd.length < 6) return toast(t("新密码至少 6 位", "The new password must be at least 6 characters"))
    setLoading(true)
    try {
      await api.changePassword(oldPwd, newPwd)
      setOldPwd("")
      setNewPwd("")
      setNewPwd2("")
      toast(t("密码修改成功", "Password changed"))
    } catch (e) {
      toast(e instanceof Error ? e.message : t("修改失败", "Change failed"))
    } finally {
      setLoading(false)
    }
  }

  const eye = (
    <button className="pwd-eye" title={show ? t("隐藏", "Hide") : t("显示", "Show")} onClick={() => setShow(!show)}>
      <EyeIcon off={show} />
    </button>
  )

  return (
    <div style={{ width: 400, display: "grid", gap: 12, paddingTop: 20 }}>
      <label className="pwd-label">
        <L
          zh={<>账号 <span style={{ color: "var(--text-strong)" }}>{username}</span> · 修改后需用新密码重新登录</>}
          en={<>Account <span style={{ color: "var(--text-strong)" }}>{username}</span> · you must log in again with the new password</>}
        />
      </label>
      <div className="pwd-row">
        <input className="field" type={show ? "text" : "password"} placeholder={t("当前密码", "Current password")} value={oldPwd}
          onChange={(e) => setOldPwd(e.target.value)} />
        {eye}
      </div>
      <div className="pwd-row">
        <input className="field" type={show ? "text" : "password"} placeholder={t("新密码（至少 6 位）", "New password (min 6 chars)")} value={newPwd}
          onChange={(e) => setNewPwd(e.target.value)} />
        {eye}
      </div>
      <div className="pwd-row">
        <input className="field" type={show ? "text" : "password"} placeholder={t("再输入一次新密码", "Repeat the new password")} value={newPwd2}
          onChange={(e) => setNewPwd2(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} />
        {eye}
      </div>
      <button className="btn btn-primary" style={{ justifyContent: "center", marginTop: 4 }} disabled={loading} onClick={submit}>
        {loading ? "..." : t("确认修改", "Change password")}
      </button>
    </div>
  )
}

// 简易 Popconfirm：点击按钮区域弹出
export function ConfirmWrap({ text, onOk, children }: { text: string; onOk: () => void; children: ReactNode }) {
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
  const { t } = useI18n()
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
          {t(
            "多 agent 协作中枢 —— 把你的 AI 编程工具组成一个虫群，让它们互相调用、协同完成任务。",
            "A multi-agent collaboration hub — turn your AI coding tools into a swarm that calls one another and gets tasks done together.",
          )}
        </p>
      </section>

      {/* 2. 马上安装 */}
      <section className="home-install">
        <h2>{t("马上安装", "Install now")}</h2>
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
            <Btn variant="icon" title="copy" onClick={async () => {
              toast(await copyText(installCmd) ? "安装命令已复制" : "复制失败，请手动选择复制")
            }}>⧉</Btn>
          )}
        </div>
        {loggedIn ? (
          <p className="home-hint" style={{ marginTop: 10 }}>
            <L
              zh={<>命令中的 API Key 可在 <a className="link" onClick={onGoAccount}>账号</a> 页查看或重置。</>}
              en={<>The API Key in the command can be viewed or reset on the <a className="link" onClick={onGoAccount}>Account</a> page.</>}
            />
          </p>
        ) : (
          <p className="home-hint" style={{ marginTop: 10 }}>
            <L
              zh={<><a className="link" onClick={onOpenLogin}>注册</a>或者<a className="link" onClick={onOpenLogin}>登录</a>账号即可安装。</>}
              en={<><a className="link" onClick={onOpenLogin}>Sign up</a> or <a className="link" onClick={onOpenLogin}>log in</a> to install.</>}
            />
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
        <h2>{t("什么是 agent_swarm？", "What is agent_swarm?")}</h2>
        <p>
          <L
            zh={<>agent_swarm 是一个自托管的多 agent 协作平台。每个 AI 编程工具（如 opencode）作为一个
              <b> agent 工作区</b>注册到中枢，虫群中的任何 agent 都可以把任务派发给其他 agent 执行——
              就像一群工蜂协作：你写代码，它跑测试，另一个整理文档。你还可以<b>组建团队、把工作区共享给团队</b>，
              让队友的 agent 也能调用它——共享的只是"调用权"，执行过程仍只对你可见。
              对于需要长期推进的目标，还可以交给<b>规划器</b>工作区：把目标拆成任务树、自动调度虫群执行并追踪验收。</>}
            en={<>agent_swarm is a self-hosted multi-agent collaboration platform. Each AI coding tool (e.g. opencode) registers as
              an <b>agent workspace</b> on the hub, and any agent in the swarm can dispatch tasks to the others —
              like a hive of worker bees: one writes code, another runs tests, a third tidies the docs. You can also <b>form teams and share workspaces</b>
              so that teammates' agents can call them too — only the <b>right to call</b> is shared; the execution stays visible only to you.
              For long-running goals you can hand them to a <b>planner</b> workspace: it breaks the goal into a task tree, dispatches the swarm and tracks acceptance.</>}
          />
        </p>
        <div className="home-grid">
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="mcp" />
              <h3>{t("开放架构，逐步支持更多 agent", "Open architecture, more agents over time")}</h3>
            </div>
            <p><L
              zh={<>面向 agent 的操作走标准 MCP 工具，工作区之间的任务派发走标准 <b>A2A 协议</b>（Linux Foundation 开放标准）。基于开放协议，claude code、deepseek harness、pi 等更多 agent 客户端得以逐步接入。</>}
              en={<>Agent-facing operations use standard MCP tools, and task dispatch between workspaces uses the standard <b>A2A protocol</b> (a Linux Foundation open standard). Because it's built on open protocols, claude code, deepseek harness, pi and more clients can be added over time.</>}
            /></p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="swarm" />
              <h3>{t("跨 agent 任务派发", "Cross-agent task dispatch")}</h3>
            </div>
            <p><L
              zh={<>一条指令把任务交给另一个工作区的 agent：支持<b>前台注入</b>（任务直接进入对方当前会话，实时可见）与<b>后台会话</b>（独立会话静默执行，按来源归组）两种方式，结果自动回传。</>}
              en={<>Hand a task to an agent in another workspace with one instruction: supports <b>foreground injection</b> (the task enters the peer's current session, visible in real time) and <b>background sessions</b> (an isolated session runs silently, grouped by caller). Results are returned automatically.</>}
            /></p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="team" />
              <h3>{t("团队与工作区共享", "Teams & workspace sharing")}</h3>
            </div>
            <p><L
              zh={<>创建团队、邀请成员，把自己的工作区<b>共享</b>给团队当工具调用：队友（或用他们的 agent）只能拿到<b>最终答复</b>，看不到你的监控流、产物与调用细节。共享的是<b>调用权</b>，不是可见权。</>}
              en={<>Create teams, invite members, and <b>share</b> your workspaces to the team as callable tools: teammates (or their agents) get only the <b>final answer</b> — they can't see your monitor stream, artifacts or call details. You share the <b>right to call</b>, not the right to see.</>}
            /></p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="planner" />
              <h3>{t("规划器：把目标拆成任务树", "Planner: turn goals into a task tree")}</h3>
            </div>
            <p><L
              zh={<>把一个模糊的<b>长期目标</b>交给规划器工作区：由规划 agent 拆解成带依赖的<b>任务树</b>，逐个派发给其他 agent 执行、持续追踪验收。支持<b>专家拆解</b>与专家验收点、在网页上<b>审批拆解</b>与人工验收，关键待办还能外推到飞书 / 微信 / 桌宠。</>}
              en={<>Give a fuzzy <b>long-term goal</b> to a planner workspace: a planning agent breaks it into a dependency-aware <b>task tree</b>, dispatches tasks to other agents and tracks acceptance. Supports <b>expert decomposition</b> and expert acceptance points, <b>plan approval</b> and manual acceptance on the web, and pushes key to-dos to Feishu / WeChat / desktop pet.</>}
            /></p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="terminal" />
              <h3>{t("中枢 Nexus", "Nexus")}</h3>
            </div>
            <p>{t(
              "在网页上选择在线工作区直接下达指令，实时观看 agent 的思考、工具调用与答复，权限请求和提问可直接点选应答。",
              "Pick an online workspace on the web and send instructions directly; watch the agent's reasoning, tool calls and answers live, and answer permission requests or questions with a click.",
            )}</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="eye" />
              <h3>{t("监控模式", "Monitor mode")}</h3>
            </div>
            <p>{t(
              "你在 agent 里的日常对话会按轮次实时同步到网页中枢：提问、思考、工具调用、回答全程可见，权限请求远程应答，历史随时回溯——像给 agent 开了一扇观察窗。",
              "Your everyday conversations with the agent sync to the web Nexus round by round: questions, reasoning, tool calls and answers are all visible, permission requests can be answered remotely, and history is always replayable — like an observation window into your agent.",
            )}</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="chat" />
              <h3>{t("即时聊天工具接入", "Chat app integration")}</h3>
            </div>
            <p><L
              zh={<>绑定飞书或微信后，直接在聊天里给 agent 派任务：按轮次时间线实时围观思考与工具调用，任务完成后收到<b>结果简报</b>，权限请求远程点选/回复应答。</>}
              en={<>After binding Feishu or WeChat, dispatch tasks to your agent right from chat: watch reasoning and tool calls as a live timeline, get a <b>result brief</b> when a task finishes, and answer permission requests by tapping or replying.</>}
            /></p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="package" />
              <h3>{t("产物管理", "Artifact management")}</h3>
            </div>
            <p><L
              zh={<>agent 通过 MCP 把产出文件（构建包、报告、数据集…）上传到中枢：飞书/微信<b>直接收到文件</b>，网页「产物」页集中管理、随时下载，默认保留 7 天，重要产物可一键固定永不清理。产物归属上传时所在的工作区，该工作区共享给团队后，队友也能看到并下载（只读）。</>}
              en={<>Agents upload output files (builds, reports, datasets…) to the hub over MCP: Feishu/WeChat <b>receive the file directly</b>, and the web Artifacts page manages and downloads them anytime. Kept 7 days by default; important artifacts can be pinned so they're never auto-cleaned. Artifacts belong to the workspace they were uploaded from; once that workspace is shared with a team, teammates can view and download them (read-only).</>}
            /></p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="pulse" />
              <h3>{t("在线状态与心跳", "Online status & heartbeat")}</h3>
            </div>
            <p>{t(
              "插件每 30 秒心跳保活，工作区看板实时展示每个 agent 的在线/离线状态与当前会话。",
              "Plugins heartbeat every 30 seconds; the workspace board shows each agent's online/offline status and current session in real time.",
            )}</p>
          </div>
          <div className="home-card">
            <div className="home-card-head">
              <FeatureIcon kind="shield" />
              <h3>{t("自托管 & 轻量", "Self-hosted & lightweight")}</h3>
            </div>
            <p>{t(
              "单个 FastAPI 服务 + SQLite，一条命令启动，数据完全留在你自己的机器上。",
              "A single FastAPI service + SQLite, started with one command; your data stays entirely on your own machine.",
            )}</p>
          </div>
        </div>
      </section>

      {/* 5. 它可以做什么？ */}
      <section className="home-about">
        <h2>{t("它可以做什么？", "What can it do?")}</h2>
        <ul className="home-list">
          <li>{t("让前端 agent 把后端 bug 派发给后端工作区的 agent 修复", "Have a frontend agent dispatch a backend bug to an agent in the backend workspace to fix")}</li>
          <li>{t("让一个 agent 去另一个仓库执行测试、汇总结果", "Have one agent run tests in another repo and summarize the results")}</li>
          <li>{t("组建团队、把工作区共享给团队：队友的 agent 像调用工具一样调用它，只回结果、不暴露过程", "Build teams and share workspaces: teammates' agents call it like a tool and get only the result, never the process")}</li>
          <li>{t("给规划器一个长期目标，让它自动拆成任务树、调度虫群里的 agent 执行并追踪验收", "Give the planner a long-term goal and let it break it into a task tree, dispatch agents across the swarm and track acceptance")}</li>
          <li>{t("在网页「中枢」里给任意在线 agent 直接下达指令，实时围观它干活", "Send instructions to any online agent from the web Nexus and watch it work live")}</li>
          <li>{t("把你在 agent 里的日常对话实时同步到网页，随时远程回看", "Sync your everyday agent conversations to the web and replay them remotely anytime")}</li>
          <li>{t("绑定飞书 / 微信等即时聊天工具，在聊天里派活、看进度、收完成简报", "Bind Feishu / WeChat and dispatch, watch progress and get completion briefs right in chat")}</li>
          <li>{t("让 agent 把构建包 / 报告等产物上传到中枢，聊天收文件、网页集中管理下载", "Have agents upload builds / reports to the hub: receive files in chat and manage downloads on the web")}</li>
          <li>{t("集中管理所有 AI 工作区的用途说明、备注与在线状态", "Centrally manage purpose notes, comments and online status of all AI workspaces")}</li>
          <li>{t("回溯每一次跨 agent 调用的指令与结果（调用记录）", "Replay the instruction and result of every cross-agent call (call records)")}</li>
        </ul>
      </section>

      {/* 6. 阅读文档 */}
      <section className="home-docs-cta">
        <a className="btn btn-primary docs-btn" onClick={onGoDocs}>{t("阅读文档 →", "Read the docs →")}</a>
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
  const { t } = useI18n()
  const tools: { tool: "opencode" | "claude" | "deepseek" | "pi" | "more"; name: string; supported: boolean }[] = [
    { tool: "opencode", name: "opencode", supported: true },
    { tool: "claude", name: "claude code", supported: true },
    { tool: "deepseek", name: "deepseek harness", supported: true },
    { tool: "pi", name: "pi", supported: false },
    { tool: "more", name: t("更多 MCP 客户端", "More MCP clients"), supported: false },
  ]
  return (
    <div className="supported-agents">
      <span className="supported-label">{t("已支持", "Supported")}</span>
      {tools.map((item) => (
        <span key={item.tool} className={`agent-tile${item.supported ? " supported" : ""}`}
          title={item.supported ? `${item.name} · ${t("已支持", "supported")}` : `${item.name} · ${t("即将支持", "coming soon")}`}>
          <AgentToolIcon tool={item.tool} />
          <span className="agent-tile-name">{item.name}</span>
        </span>
      ))}
    </div>
  )
}

/** 特性卡黑白线性图标（与 SwarmMark 同风格：currentColor 描边） */
function FeatureIcon({ kind }: { kind: "mcp" | "swarm" | "team" | "pulse" | "shield" | "terminal" | "eye" | "chat" | "package" | "planner" }) {
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
  if (kind === "chat")
    return (
      <svg {...common}>
        {/* 聊天气泡 = 即时聊天工具接入 */}
        <path d="M21 12a8 8 0 0 1-8 8H4l2.5-2.5A8 8 0 1 1 21 12Z" />
        <path d="M8.5 10.5h7M8.5 14h4.5" />
      </svg>
    )
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

  if (kind === "team")
    return (
      <svg {...common}>
        {/* 几个人 = 团队协作 / 工作区共享 */}
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
        <path d="M16 6.3a3 3 0 0 1 0 5.4M17.5 20c0-2.3-.9-4-2.4-5" />
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
  if (kind === "package")
    return (
      <svg {...common}>
        {/* 包裹箱 = 产物管理 */}
        <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
        <path d="m3 8 9 5 9-5" />
        <path d="M12 13v8" />
      </svg>
    )
  if (kind === "planner")
    return (
      <svg {...common}>
        {/* 清单 + 勾 = 目标拆解 / 规划器 */}
        <path d="M3.5 6.5 5 8l2.5-2.5" />
        <path d="M3.5 12.5 5 14l2.5-2.5" />
        <path d="M3.5 18.5 5 20l2.5-2.5" />
        <path d="M10.5 6.5H21M10.5 12.5H21M10.5 18.5H17" />
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
  { id: "intro", zh: "介绍", en: "Introduction" },
  { id: "install", zh: "安装插件", en: "Install plugins" },
  { id: "register", zh: "注册工作区", en: "Register a workspace" },
  { id: "concepts", zh: "核心概念", en: "Core concepts" },
  { id: "planner", zh: "规划器", en: "Planner" },
  { id: "commands", zh: "命令", en: "Commands" },
  { id: "chat", zh: "即时聊天工具", en: "Chat apps" },
  { id: "mcp", zh: "MCP 工具", en: "MCP tools" },
  { id: "web", zh: "Web 管理", en: "Web console" },
  { id: "faq", zh: "FAQ", en: "FAQ" },
]

function DocsPage() {
  const { t } = useI18n()
  const [active, setActive] = useState(DOC_SECTIONS[0].id)

  // 点击目录：滚动到对应区块
  const jump = (id: string) => {
    document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
    setActive(id)
  }

  return (
    <div className="subpage">
      <aside className="subpage-toc">
        <p className="section-label">{t("[ 文档 ]", "[ Docs ]")}</p>
        {DOC_SECTIONS.map((s) => (
          <a key={s.id} className={`subpage-item${active === s.id ? " active" : ""}`}
            onClick={() => jump(s.id)}>
            {t(s.zh, s.en)}
          </a>
        ))}
      </aside>
      <article className="subpage-body">
        <section id="doc-intro" className="docs-section">
          <h2>{t("介绍", "Introduction")}</h2>
          <p>
            <L
              zh={<><b>agent_swarm</b> 把你的 AI 编程工具（opencode 等）组织成一个「虫群」：
                每个工具实例作为一个<b>工作区</b>注册进来，任意 agent 都可以把任务派发给其他 agent 执行——
                你写代码，它跑测试，另一个整理文档。</>}
              en={<><b>agent_swarm</b> organizes your AI coding tools (opencode and friends) into a "swarm":
                each tool instance registers as a <b>workspace</b>, and any agent can dispatch tasks to the others —
                one writes code, another runs tests, a third tidies the docs.</>}
            />
          </p>
          <p>{t("七个核心特点：", "Seven core features:")}</p>
          <ul>
            <li><L
              zh={<><b>开放标准协议</b> —— agent 操作是标准 MCP 工具，任务派发走标准 A2A 协议（Linux Foundation 开放标准），任何兼容客户端均可接入</>}
              en={<><b>Open standard protocols</b> — agent operations are standard MCP tools, and task dispatch uses the standard A2A protocol (a Linux Foundation open standard); any compatible client can join</>}
            /></li>
            <li><L
              zh={<><b>跨 agent 任务派发</b> —— 支持前台注入（任务进入对方当前会话，实时可见）与后台会话（独立会话静默执行）两种方式，结果自动回传</>}
              en={<><b>Cross-agent task dispatch</b> — foreground injection (the task enters the peer's current session, visible live) or background sessions (an isolated session runs silently); results are returned automatically</>}
            /></li>
            <li><L
              zh={<><b>团队与工作区共享</b> —— 组建团队，把工作区共享给团队当工具调用：共享的是<b>调用权</b>不是<b>可见权</b>，队友只拿到最终答复，看不到你的监控流、产物与调用细节</>}
              en={<><b>Teams & workspace sharing</b> — form teams and share workspaces as callable tools: you share the <b>right to call</b>, not the <b>right to see</b>; teammates get only the final answer and can't see your monitor stream, artifacts or call details</>}
            /></li>
            <li><L
              zh={<><b>中枢 Nexus</b> —— 在网页上直接给任意在线 agent 下指令，实时观看它思考、调用工具、给出答复</>}
              en={<><b>Nexus</b> — send instructions to any online agent from the web and watch it reason, call tools and answer in real time</>}
            /></li>
            <li><L
              zh={<><b>规划器</b> —— 把模糊的长期目标交给规划器工作区：自动拆成带依赖的<b>任务树</b>、调度虫群执行并追踪验收（专家拆解 / 人工审批 / 专家验收点）</>}
              en={<><b>Planner</b> — give a fuzzy long-term goal to a planner workspace: it breaks it into a dependency-aware <b>task tree</b>, dispatches the swarm and tracks acceptance (expert decomposition / manual approval / expert acceptance points)</>}
            /></li>
            <li><L
              zh={<><b>实时看板</b> —— 工作区在线状态、每次调用的指令与结果，随时可查</>}
              en={<><b>Live board</b> — workspace online status and the instruction + result of every call, always available</>}
            /></li>
            <li><L
              zh={<><b>即时聊天工具接入</b> —— 绑定飞书/微信，在聊天里派任务、收时间线直播与完成简报、远程应答权限请求（规划器的拆解 / 验收待办也会推送到此）</>}
              en={<><b>Chat app integration</b> — bind Feishu/WeChat to dispatch tasks, receive a live timeline and completion briefs, and answer permission requests remotely (planner decomposition / acceptance to-dos are pushed here too)</>}
            /></li>
          </ul>
          <p>
            <L
              zh={<>接入后，你的 agent 会多出一组「虫群工具」：注册工作区、查看其他工作区、派发任务、查询结果——
                都可以在对话里自然地让 agent 使用。</>}
              en={<>Once connected, your agent gains a set of "swarm tools": register a workspace, list other workspaces,
                dispatch tasks and fetch results — all usable naturally in conversation.</>}
            />
          </p>
        </section>

        <section id="doc-install" className="docs-section">
          <h2>{t("安装插件", "Install plugins")}</h2>
          <p>
            <L
              zh={<>插件是 agent 接入虫群的载体，负责心跳保活与接收任务。每个 agent 工具一个插件，
                一条安装命令可以把所有已支持的插件一次装好。</>}
              en={<>A plugin is how an agent joins the swarm; it keeps the heartbeat alive and receives tasks.
                There is one plugin per agent tool, and a single install command can set them all up at once.</>}
            />
          </p>
          <h3>{t("安装方式", "How to install")}</h3>
          <p>
            <L
              zh={<>在目标机器上执行<b>首页</b>生成的安装命令（已自动带上你的账号 API Key）。
                安装器会下载分发包并逐个安装各 agent 插件（可选参数只装指定插件）。</>}
              en={<>Run the install command generated on the <b>Home</b> page on the target machine (it already carries your account API Key).
                The installer downloads the distribution and installs each agent plugin in turn (optional flags install only the ones you pick).</>}
            />
          </p>
          <ul>
            <li>
              <L
                zh={<><b>opencode</b>：写入服务配置 → 注册 MCP 端点 → 部署心跳插件 → 拷贝 <code>/swarm-*</code> 命令。
                  <b>重启 opencode 后生效</b>——插件在会话启动时加载，运行中的会话不会热更新。</>}
                en={<><b>opencode</b>: write the service config → register the MCP endpoint → deploy the heartbeat plugin → copy the <code>/swarm-*</code> commands.
                  <b>Takes effect after restarting opencode</b> — the plugin loads at session start, and running sessions are not hot-reloaded.</>}
              />
            </li>
            <li>
              <L
                zh={<><b>claude code</b>：<code>claude mcp add</code> 注册 remote MCP（虫群工具）+ 本地 keepalive MCP
                  （claude 启动时自动 spawn 保活进程，退出自动回收）→ 拷贝 <code>/swarm-*</code> 命令。
                  <b>重启 claude 后生效</b>。claude 工作区支持注册管理、在线状态与后台会话任务执行；
                  前台注入暂不支持（见「命令」章节的支持情况表）。</>}
                en={<><b>claude code</b>: <code>claude mcp add</code> registers the remote MCP (swarm tools) plus a local keepalive MCP
                  (claude spawns the keepalive process on start and reaps it on exit) → copy the <code>/swarm-*</code> commands.
                  <b>Takes effect after restarting claude</b>. claude workspaces support registration management, online status and background-session task execution;
                  foreground injection is not supported yet (see the support table in the "Commands" section).</>}
              />
            </li>
            <li>
              <L
                zh={<><b>deepseek harness</b>：安装 cordis bundle 插件（<code>dsh plugin add</code>，按 profile 安装）
                  → 写入 MCP 配置（agent-swarm-mcp）→ 拷贝 <code>/swarm-*</code> 命令。
                  <b>重启 dsh 后生效</b>。注册工作区走会话内 <code>/swarm-add</code>（安装脚本不注册）。
                  支持前台注入（最近活跃会话）、后台 per-caller 会话、监控同步与权限/提问应答
                  （详见「命令」章节的支持情况表）。</>}
                en={<><b>deepseek harness</b>: install the cordis bundle plugin (<code>dsh plugin add</code>, per profile)
                  → write the MCP config (agent-swarm-mcp) → copy the <code>/swarm-*</code> commands.
                  <b>Takes effect after restarting dsh</b>. Register a workspace with <code>/swarm-add</code> inside a session (the installer does not register it).
                  Supports foreground injection (most recently active session), per-caller background sessions, monitor sync and permission/question answering
                  (see the support table in the "Commands" section).</>}
              />
            </li>
          </ul>
          <h3>{t("验证安装", "Verify the installation")}</h3>
          <p>
            <L
              zh={<>重启后打开「工作区」页，约 30 秒内应看到该机器的工作区状态点变绿（online）。
                opencode 可查看 <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code>；
                claude 可查看 <code>~/.claude/agent-swarm/keepalive.log</code>；
                deepseek harness 可查看 <code>~/.config/dsh/agent-swarm/plugin.log</code>。</>}
              en={<>After restarting, open the "Workspaces" page; within about 30 seconds the machine's workspace status dot should turn green (online).
                For opencode check <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code>;
                for claude check <code>~/.claude/agent-swarm/keepalive.log</code>;
                for deepseek harness check <code>~/.config/dsh/agent-swarm/plugin.log</code>.</>}
            />
          </p>
        </section>

        <section id="doc-register" className="docs-section">
          <h2>{t("注册工作区", "Register a workspace")}</h2>
          <p>
            <L
              zh={<>安装插件后，把一个项目目录注册为工作区，它才算真正加入虫群（可被发现、被派发任务）。
                一个机器可以注册多个工作区，每个项目一个。</>}
              en={<>After installing the plugin, register a project directory as a workspace before it truly joins the swarm (discoverable and dispatchable).
                One machine can register many workspaces, one per project.</>}
            />
          </p>
          <h3>{t("注册方式", "How to register")}</h3>
          <p>{t("任选其一：", "Pick either way:")}</p>
          <ul>
            <li>{t("在该项目的 agent 对话里使用 /swarm-add 命令（opencode、claude 与 deepseek harness 均可用）", "Use the /swarm-add command in that project's agent conversation (available in opencode, claude and deepseek harness)")}</li>
            <li><L
              zh={<>直接让 agent：「帮我把当前目录注册到虫群」（它会调用 <code>workspace_add</code> 工具）</>}
              en={<>Just tell the agent: "register the current directory to the swarm" (it calls the <code>workspace_add</code> tool)</>}
            /></li>
          </ul>
          <p>
            <L
              zh={<>注册时会要求 agent 总结这个目录的用途与能力（显示在「工作区」页，方便其他 agent 了解找谁帮忙）。
                注册成功后，工作区 ID 会写入项目根的 <code>.agent_swarm/workspace.md</code> 文件，后续心跳自动带身份。</>}
              en={<>During registration the agent summarizes this directory's purpose and capabilities (shown on the "Workspaces" page so other agents know who to ask).
                Once registered, the workspace ID is written to <code>.agent_swarm/workspace.md</code> in the project root, and later heartbeats carry the identity automatically.</>}
            />
          </p>
          <h3>{t("管理已注册的工作区", "Manage registered workspaces")}</h3>
          <p>
            <L
              zh={<>「工作区」页可以启用/禁用（disabled 的工作区不参与任务派发）、删除离线工作区、修改备注。
                也可以在 agent 里用 <code>workspace_enable</code> / <code>workspace_disable</code> 等工具操作。</>}
              en={<>The "Workspaces" page lets you enable/disable (disabled workspaces are not dispatched tasks), delete offline workspaces and edit comments.
                You can also use tools like <code>workspace_enable</code> / <code>workspace_disable</code> from the agent.</>}
            />
          </p>
          <h3>{t("开始协作", "Start collaborating")}</h3>
          <p>{t("注册完成后，在 agent 对话里让它派发任务即可：", "Once registered, just have it dispatch a task from the agent conversation:")}</p>
          <pre><code><L
            zh={`你: 调用 nas_brain 工作区，查看它最新一次 git 提交\nagent: (a2a_call) → 对方 TUI 实时出现任务 → 执行 → 结果自动回传`}
            en={`You: call the nas_brain workspace and check its latest git commit\nagent: (a2a_call) → the task appears live in the peer's TUI → it runs → the result is returned automatically`}
          /></code></pre>
        </section>

        <section id="doc-concepts" className="docs-section">
          <h2>{t("核心概念", "Core concepts")}</h2>
          <h3>{t("工作区（Workspace）", "Workspace")}</h3>
          <p>
            <L
              zh={<>一个接入虫群的 agent 实例。注册后获得唯一 ID，持久化在项目根 <code>.agent_swarm/workspace.md</code> 的
                <code>WORKSPACE_ID:</code> 行。插件每 30 秒心跳保活，超过 90 秒无心跳视为离线；
                禁用（disabled）的工作区不可见、不参与任务派发。</>}
              en={<>An agent instance joined to the swarm. It gets a unique ID on registration, persisted in the
                <code>WORKSPACE_ID:</code> line of <code>.agent_swarm/workspace.md</code> in the project root. The plugin heartbeats every 30 seconds;
                no heartbeat for over 90 seconds counts as offline. Disabled workspaces are hidden and are not dispatched tasks.</>}
            />
          </p>
          <h3>{t("调用（A2A 协议）", "Calls (A2A protocol)")}</h3>
          <p>
            <L
              zh={<>一次跨 agent 任务派发就是一个 <b>A2A 任务</b>（Linux Foundation A2A 0.3.x 开放协议，
                JSON-RPC over HTTP + WebSocket 事件流），状态流转：
                <code>queued → working → completed / failed / canceled</code>，需要对方确认时进入
                <code>input-required</code>。执行方式分前台/后台两种（见下节），
                完成后最后一条 assistant 回复自动回传给调用方。</>}
              en={<>Each cross-agent task dispatch is an <b>A2A task</b> (Linux Foundation A2A 0.3.x open protocol,
                JSON-RPC over HTTP + a WebSocket event stream). State flow:
                <code>queued → working → completed / failed / canceled</code>, entering
                <code>input-required</code> when the peer must confirm. Execution is foreground or background (next section);
                on completion the last assistant reply is returned to the caller automatically.</>}
            />
          </p>
          <h3>{t("长任务完成提醒", "Completion reminders for long tasks")}</h3>
          <p>
            <L
              zh={<>跨工作区的任务有时会跑很久：发起方 agent 等不到结果就失去耐心收轮，工作停在那里，
                结果留在任务记录里没人取。虫群会自动补位——任务完成后稍等片刻，若结果仍未被发起方
                取走（且发起方前台轮已收尾或离线），服务端会向发起方推送一条<b>完成提醒</b>：
                agent 收到后调用 <code>a2a_task</code> 取回结果并继续原本的工作。已取走结果的任务不会重复提醒；
                发起方离线时提醒会排队，上线即送达。</>}
              en={<>Cross-workspace tasks can run for a long time: the calling agent may run out of patience and end its turn without a result,
                leaving the work parked and the result unclaimed in the task record. The swarm steps in — shortly after the task completes,
                if the result is still unclaimed (and the caller's foreground turn has ended or it is offline), the server pushes a
                <b>completion reminder</b> to the caller: the agent then calls <code>a2a_task</code> to fetch the result and resume its work.
                Tasks whose result was already fetched are not re-reminded; reminders queue while the caller is offline and are delivered when it comes back online.</>}
            />
          </p>
          <h3>{t("团队与工作区共享", "Teams & workspace sharing")}</h3>
          <p>
            <L
              zh={<>「团队」页可创建团队、按用户名邀请成员，或让他人申请加入（队长审批）；队长可踢人、移交、解散。
                工作区属主可把自己的工作区<b>共享</b>给自己所在的任一团队。共享<strong>只授予调用权，不授予可见权</strong>：</>}
              en={<>The "Teams" page lets you create teams, invite members by username, or let others request to join (approved by the captain);
                the captain can kick, transfer or disband. A workspace owner can <b>share</b> their workspace to any team they belong to.
                Sharing grants <strong>only the right to call, not the right to see</strong>:</>}
            />
          </p>
          <ul>
            <li><L
              zh={<>队友可 <code>a2a_call</code> 共享工作区并拿到<b>最终答复</b>——看不到思考、工具调用、监控轮、产物、简报与调用细节</>}
              en={<>Teammates can <code>a2a_call</code> a shared workspace and get the <b>final answer</b> — they can't see reasoning, tool calls, monitor rounds, artifacts, briefs or call details</>}
            /></li>
            <li><L
              zh={<>完成简报与权限/提问卡仍<b>只发给工作区属主</b>，调用方收不到</>}
              en={<>Completion briefs and permission/question cards still go <b>only to the workspace owner</b>; the caller does not receive them</>}
            /></li>
            <li><L
              zh={<>被共享的工作区<b>不会</b>出现在队友的中枢 / 工作区列表里；调用记录里双方各自只看得到该条「指令 + 答复」</>}
              en={<>A shared workspace does <b>not</b> appear in the teammate's Nexus / workspace list; in call records each side sees only that "instruction + answer" entry</>}
            /></li>
            <li><L
              zh={<>发现与调用都走 MCP（<code>list_workspaces</code> 里带 <code>shared:true</code>），网页端不提供共享工作区的调用入口</>}
              en={<>Discovery and calls both go through MCP (<code>list_workspaces</code> marks them <code>shared:true</code>); the web console provides no call entry for shared workspaces</>}
            /></li>
          </ul>
          <h3>{t("前台会话与后台会话", "Foreground vs. background sessions")}</h3>
          <p>
            {t("每个工作区收到任务时，按配置选择执行方式：", "When a workspace receives a task, it picks an execution mode by configuration:")}
          </p>
          <ul>
            <li>
              <L
                zh={<><b>前台会话（foreground）</b>：任务直接注入对方<b>正在看的 TUI 会话</b>并弹 toast 通知——
                  你在屏幕上就能看到 agent 干活的全部过程（思考、工具调用、答复），也能随时打断、应答权限。
                  适合需要人监督的任务。</>}
                en={<><b>Foreground session</b>: the task is injected into the <b>TUI session the peer is currently watching</b> and a toast pops up —
                  you see the whole process on screen (reasoning, tool calls, answer) and can interrupt or answer permissions at any time.
                  Good for tasks that need supervision.</>}
              />
            </li>
            <li>
              <L
                zh={<><b>后台会话（background）</b>：目标端 spawn 一个独立的 headless 进程静默执行，
                  <b>完全不碰当前 TUI 会话</b>。同一来源（如网页中枢、某个调用方 agent）的任务自动归组到
                  同一个后台会话，保证多轮对话的连续性。权限全自动批准（无人值守），默认 30 分钟超时，
                  最多 3 个并发。适合耗时任务批量派发、agent 互调时不想打扰对方。</>}
                en={<><b>Background session</b>: the target spawns an isolated headless process that runs silently,
                  <b>without touching the current TUI session</b>. Tasks from the same source (e.g. the web Nexus, a calling agent) are grouped into
                  the same background session, keeping multi-turn continuity. Permissions are auto-approved (unattended), with a default 30-minute timeout
                  and at most 3 concurrent. Good for batch-dispatching long tasks or agent-to-agent calls without disturbing the peer.</>}
              />
            </li>
          </ul>
          <p>
            <L
              zh={<>切换方式：在 opencode 里执行 <code>/swarm-mode</code> 命令选择前台或后台，即时生效（无需重启）。
                也可编辑全局配置 <code>~/.config/opencode/agent-swarm.json</code> 的 <code>executionMode</code> 字段。</>}
              en={<>To switch: run <code>/swarm-mode</code> in opencode and choose foreground or background; it takes effect immediately (no restart).
                You can also edit the <code>executionMode</code> field in <code>~/.config/opencode/agent-swarm.json</code>.</>}
            />
          </p>
          <h3>{t("监控模式（前台会话实时同步）", "Monitor mode (live foreground sync)")}</h3>
          <p>
            <L
              zh={<>开启后，你在 agent 里与它的<b>日常对话</b>会按轮次实时同步到网页中枢：
                每一次提问、agent 的思考、工具调用、最终回答，以及权限请求/AI 提问，都会以独立「轮次」出现在
                中枢时间线里，与 A2A 任务轮混排显示。你可以在网页上远程围观同事屏幕上的对话过程、回溯任意一轮历史
                （中枢时间线上滚逐轮加载），监控轮次的权限请求同样可以在网页上远程应答。</>}
              en={<>When enabled, your <b>everyday conversations</b> with the agent sync to the web Nexus round by round:
                each question, the agent's reasoning, tool calls, final answer, and any permission request / AI question appear as separate rounds in the
                Nexus timeline, interleaved with A2A task rounds. You can watch a colleague's on-screen conversation remotely, replay any past round
                (scroll up to load rounds lazily), and answer the permission requests of monitor rounds from the web too.</>}
            />
          </p>
          <ul>
            <li><L
              zh={<><b>只监控前台会话</b>——后台任务会话不经过此通道，不会重复上报；中枢下发的任务轮也自动去重</>}
              en={<><b>Foreground only</b> — background task sessions don't go through this channel and aren't double-reported; Nexus-dispatched task rounds are de-duplicated automatically</>}
            /></li>
            <li><L
              zh={<><b>开关</b>——在飞书/微信渠道侧关闭监控转发即可；不想让某个项目被围观就不在该项目注册工作区</>}
              en={<><b>Toggle</b> — turn off monitor forwarding on the Feishu/WeChat channel side; if you don't want a project observed, simply don't register a workspace for it</>}
            /></li>
            <li><L
              zh={<><b>归档</b>：每轮对话作为一条 <code>[monitor]</code> 记录进入「调用记录」页（按工作区筛选查看），与 A2A 任务记录并列</>}
              en={<><b>Archive</b>: each conversation round enters the "Calls" page as a <code>[monitor]</code> record (filter by workspace), alongside A2A task records</>}
            /></li>
          </ul>
          <h3>{t("心跳与在线状态", "Heartbeat & online status")}</h3>
          <p>
            {t("插件每 30 秒心跳一次并上报当前会话信息。在线状态可在「工作区」页实时查看。",
              "The plugin heartbeats every 30 seconds and reports the current session info. Online status is visible live on the \"Workspaces\" page.")}
          </p>
        </section>

        <section id="doc-planner" className="docs-section">
          <h2>{t("规划器", "Planner")}</h2>
          <p>
            <L
              zh={<>规划器把模糊的<b>长期目标</b>拆成带依赖的<b>任务树</b>，派给其它工作区执行并持续追踪验收。
                它由 <b>规划核心服务</b>＋一个 agent harness（做拆解与决策的 agent）组成——
                核心服务是确定性内核，管目标 / 任务 / 依赖 / 验收的持久化与调度——并作为平台上<b>特殊的「规划器工作区」</b>接入。</>}
              en={<>The planner breaks a fuzzy <b>long-term goal</b> into a dependency-aware <b>task tree</b>, dispatches the tasks to other workspaces and tracks acceptance.
                It consists of a <b>planning core service</b> plus an agent harness (the agent that decomposes and decides) —
                the core service is the deterministic kernel that persists and schedules goals / tasks / dependencies / acceptance — and joins the platform as a <b>special "planner workspace"</b>.</>}
            />
          </p>
          <h3>{t("规划器工作区是什么？", "What is a planner workspace?")}</h3>
          <p>
            <L
              zh={<>规划器工作区是一个<b>特殊的工作区</b>。普通工作区只代表一个 agent 实例；规划器工作区则是
                「<b>规划核心服务＋一个 agent harness（负责拆解的 agent）</b>」的组合，两者跑在同一个项目目录里——
                核心服务负责<b>目标 / 任务 / 依赖 / 验收的持久化与调度</b>，harness 里的 agent 负责把目标<b>拆解成任务树</b>并在执行中做决策。</>}
              en={<>A planner workspace is a <b>special workspace</b>. An ordinary workspace represents just one agent instance; a planner workspace is
                a combination of a <b>planning core service + an agent harness (the decomposing agent)</b>, running in the same project directory —
                the core service <b>persists and schedules goals / tasks / dependencies / acceptance</b>, while the agent in the harness <b>breaks the goal into a task tree</b> and makes decisions during execution.</>}
            />
          </p>
          <p>
            <L
              zh={<>正因为它不是一个普通 agent，接入方式也<b>特殊</b>：先安装并运行<b>规划核心服务</b>（见下方「安装与准备」），
                再在<b>该目录里</b>用专门的 <b><code>/swarm-add-planner</code></b> 命令注册——而不是普通的 <code>/swarm-add</code>；
                注册后这个工作区就会被平台识别为<b>规划器工作区</b>。</>}
              en={<>Because it is not an ordinary agent, joining works <b>differently</b>: first install and run the <b>planning core service</b> (see "Install & prepare" below),
                then register from <b>that directory</b> with the dedicated <b><code>/swarm-add-planner</code></b> command — not the plain <code>/swarm-add</code>;
                once registered the platform recognizes the workspace as a <b>planner workspace</b>.</>}
            />
          </p>
          <h3>{t("安装与准备", "Install & prepare")}</h3>
          <ol>
            <li>{t("环境：Python ≥ 3.11，以及一个已装 agent-swarm 插件的 harness（opencode / claude / deepseek 任一）。",
              "Environment: Python ≥ 3.11, plus a harness with the agent-swarm plugin installed (opencode / claude / deepseek, any one).")}</li>
            <li>
              <L
                zh={<><b>获取并安装规划核心服务</b>：源码仓库
                  <a className="link" href="https://github.com/RisingWater/agent_swarm_planner"
                    target="_blank" rel="noreferrer">agent_swarm_planner</a>。
                  最省事的方式是在网页「规划器」页（还没有规划器工作区时）复制平台提供的<b>一键安装命令</b>——
                  它会克隆到 <code>~/.agent_swarm/agent_swarm_planner</code> 并自动安装。也可手动：克隆仓库后在其根目录执行
                  <code>./deploy/install.sh</code>（Windows：<code>.\deploy\install.ps1 -Server &lt;平台地址&gt; -ApiKey as_xxx</code>）。
                  安装会建虚拟环境、装依赖、写配置、建库，并可注册开机自启。</>}
                en={<><b>Fetch and install the planning core service</b>: source repo
                  <a className="link" href="https://github.com/RisingWater/agent_swarm_planner"
                    target="_blank" rel="noreferrer">agent_swarm_planner</a>.
                  The easiest way is to copy the platform's <b>one-click install command</b> on the web "Planner" page (when you have no planner workspace yet) —
                  it clones to <code>~/.agent_swarm/agent_swarm_planner</code> and installs automatically. Or do it manually: clone the repo and run from its root
                  <code>./deploy/install.sh</code> (Windows: <code>.\deploy\install.ps1 -Server &lt;platform-url&gt; -ApiKey as_xxx</code>).
                  The install creates a virtualenv, installs dependencies, writes config, sets up the database and can register auto-start on boot.</>}
              />
            </li>
            <li><L
              zh={<><b>自检与常驻</b>：<code>planner doctor</code> 自检；<code>planner serve</code> 前台运行；<code>planner service install</code> 注册为开机自启服务（<code>planner service status</code> 查看）。</>}
              en={<><b>Self-check & keep running</b>: <code>planner doctor</code> to self-check; <code>planner serve</code> to run in the foreground; <code>planner service install</code> to register it as a boot service (check with <code>planner service status</code>).</>}
            /></li>
            <li><L
              zh={<><b>注册为规划器工作区</b>：在规划核心服务的目录启动 harness，输入 <code>/swarm-add-planner</code>（opencode / claude / deepseek 都支持；dsh 脚本化可用 <code>register.mjs --role planner</code>）。成功后网页出现「规划器」入口。</>}
              en={<><b>Register as a planner workspace</b>: start the harness in the planning core service's directory and enter <code>/swarm-add-planner</code> (supported by opencode / claude / deepseek; for scripted dsh use <code>register.mjs --role planner</code>). Afterwards the "Planner" entry appears on the web.</>}
            /></li>
            <li>{t("若该 harness 还没接入虫群：先在平台管理页复制「插件安装」一键命令装好插件，再执行上一步。",
              "If the harness hasn't joined the swarm yet: first copy the one-click \"plugin install\" command on the platform page to install the plugin, then do the previous step.")}</li>
          </ol>
          <h3>{t("怎么用（上手步骤）", "How to use it (getting started)")}</h3>
          <ol>
            <li><L
              zh={<><b>新建目标</b>：在网页「规划器」页选一个 planner 工作区，新建目标——填标题 / 描述、优先级（高 / 中 / 低）、截止（可空）、成功标准；可指定<b>专家工作区</b>（选当前 planner 工作区自身即为<b>自评审</b>，不派 A2A）。</>}
              en={<><b>Create a goal</b>: on the web "Planner" page pick a planner workspace and create a goal — title / description, priority (high / medium / low), deadline (optional), success criteria; you can name an <b>expert workspace</b> (choosing the planner workspace itself means <b>self-review</b>, with no A2A dispatch).</>}
            /></li>
            <li><L
              zh={<><b>确认与拆解</b>：规划器 agent 与专家确认成功标准并生成任务树（含<b>专家验收点</b>）。此阶段 <code>拆解=draft</code>，页面只展示、不派发。</>}
              en={<><b>Confirm & decompose</b>: the planner agent confirms the success criteria with the expert and generates a task tree (including <b>expert acceptance points</b>). At this stage <code>plan=draft</code>; the page only displays, it does not dispatch.</>}
            /></li>
            <li><L
              zh={<><b>通过拆解</b>：人工点「通过拆解」后 agent 才按依赖层开始派发；点「重新拆解」让 agent 重做（回到 draft）。</>}
              en={<><b>Approve the plan</b>: only after a human clicks "Approve plan" does the agent start dispatching layer by layer; "Re-plan" makes the agent redo it (back to draft).</>}
            /></li>
            <li><L
              zh={<><b>派发执行</b>：任务逐个派给对应工作区的 agent（派单会自动要求对方先压缩上下文），worker 的终态自动回写到核心服务。</>}
              en={<><b>Dispatch & execute</b>: tasks are dispatched one by one to the agents of the matching workspaces (dispatch automatically asks the peer to compact context first); the worker's terminal state is written back to the core service automatically.</>}
            /></li>
            <li><L
              zh={<><b>验收</b>：<code>auto</code> 自动判定；<code>manual</code> 任务完成后进入待验收，网页点「通过 / 拒绝」；<code>expert</code>「专家验收点」由规划器 agent 汇总情况后请专家裁决（专家可整树调整、回到 draft 再审）。</>}
              en={<><b>Acceptance</b>: <code>auto</code> is decided automatically; <code>manual</code> tasks wait for acceptance once done, and you click "Approve / Reject" on the web; <code>expert</code> acceptance points have the planner agent summarize and ask the expert to decide (the expert can adjust the whole tree and send it back to draft for re-review).</>}
            /></li>
            <li><L
              zh={<><b>生命周期</b>：「归档」（软隐藏，可「激活」恢复）/「删除」（级联任务树，不可恢复，二次确认）；全部任务完成后目标自动完成；列表可勾选「隐藏已归档目标」。</>}
              en={<><b>Lifecycle</b>: "Archive" (soft-hide, restorable with "Activate") / "Delete" (cascades the task tree, irreversible, with a confirm dialog); the goal completes automatically when all tasks are done; the list has a "hide archived goals" checkbox.</>}
            /></li>
          </ol>
        </section>

        <section id="doc-commands" className="docs-section">
          <h2>{t("命令", "Commands")}</h2>
          <p>
            <L
              zh={<>安装插件后，agent 对话里可以使用一组 <code>/swarm-*</code> 命令（TUI 内输入，
                静默执行 + toast 反馈）。它们是 MCP 工具的快捷方式，不用记工具参数。</>}
              en={<>After installing the plugin, a set of <code>/swarm-*</code> commands is available in the agent conversation (type them in the TUI;
                they run silently with a toast). They are shortcuts for the MCP tools, so you don't have to remember tool arguments.</>}
            />
          </p>
          <table>
            <thead><tr><th>{t("命令", "Command")}</th><th>{t("说明", "Description")}</th></tr></thead>
            <tbody>
              <tr>
                <td><code>/swarm-add</code></td>
                <td><L
                  zh={<>注册当前目录为工作区。agent 会分析项目生成用途/能力描述，调 <code>workspace_add</code>，并把工作区 ID 写入项目根 <code>.agent_swarm/workspace.md</code></>}
                  en={<>Register the current directory as a workspace. The agent analyzes the project to write a purpose/capability description, calls <code>workspace_add</code>, and writes the workspace ID to <code>.agent_swarm/workspace.md</code> in the project root</>}
                /></td>
              </tr>
              <tr>
                <td><code>/swarm-add-planner</code></td>
                <td><L
                  zh={<>注册（或更新）当前目录为<b>规划器工作区</b>——其余流程同 <code>/swarm-add</code>，但 <code>/swarm-add</code> 本身<b>不加</b>任何参数。opencode / claude / deepseek(dsh) 三个 harness 均支持。注册后可在网页「规划器」页管理目标与任务树</>}
                  en={<>Register (or update) the current directory as a <b>planner workspace</b> — otherwise the same as <code>/swarm-add</code>, but <code>/swarm-add</code> itself takes <b>no</b> arguments. Supported by all three harnesses: opencode / claude / deepseek(dsh). Once registered you can manage goals and the task tree on the web "Planner" page</>}
                /></td>
              </tr>
              <tr>
                <td><code>/swarm-remove</code></td>
                <td>{t("把当前工作区从虫群移除（工作区在线时需先禁用，等心跳过期后才能删）",
                  "Remove the current workspace from the swarm (if it is online, disable it first and wait for the heartbeat to expire before deleting)")}</td>
              </tr>
              <tr>
                <td><code>/swarm-enable</code></td>
                <td>{t("启用当前工作区（恢复可见、参与任务派发）",
                  "Enable the current workspace (visible again, receives dispatched tasks)")}</td>
              </tr>
              <tr>
                <td><code>/swarm-disable</code></td>
                <td>{t("禁用当前工作区（不可见、不再接收任务）",
                  "Disable the current workspace (hidden, no longer receives tasks)")}</td>
              </tr>
              <tr>
                <td><code>/swarm-mode</code></td>
                <td>{t("切换任务执行模式：前台注入（foreground）或后台会话（background），即时生效（opencode / deepseek harness）",
                  "Switch the task execution mode: foreground injection (foreground) or background session (background); takes effect immediately (opencode / deepseek harness)")}</td>
              </tr>
            </tbody>
          </table>
          <p>
            {t("前台会话实时监控在 opencode 与 deepseek harness 上均可用：你在 agent 里的日常对话（提问/思考/工具/回答）会实时同步到网页中枢；不想同步时在飞书/微信渠道侧关闭监控转发即可。",
              "Live foreground monitoring works on opencode and deepseek harness: your everyday conversations (questions / reasoning / tools / answers) sync to the web Nexus in real time; to stop syncing, turn off monitor forwarding on the Feishu/WeChat channel side.")}
          </p>
          <h3>{t("各 agent 支持情况", "Per-agent support")}</h3>
          <table>
            <thead><tr><th>{t("能力", "Capability")}</th><th>opencode</th><th>claude code</th><th>deepseek harness</th></tr></thead>
            <tbody>
              <tr><td>{t("注册 / 保活 / 启停管理", "Register / keep-alive / enable-disable")}</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td><code>/swarm-*</code> {t("命令", "commands")}</td><td>✅</td><td>{t("✅（不含 /swarm-mode）", "✅ (no /swarm-mode)")}</td><td>✅</td></tr>
              <tr><td>{t("前台注入（任务进入当前会话）", "Foreground injection (task enters current session)")}</td><td>✅</td><td>—</td><td>{t("✅（注入最近活跃会话）", "✅ (most recently active session)")}</td></tr>
              <tr><td>{t("后台会话（独立会话静默执行）", "Background session (isolated, silent)")}</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>{t("前台会话监控（TUI 对话同步中枢）", "Foreground monitoring (TUI syncs to Nexus)")}</td><td>✅</td><td>—</td><td>✅</td></tr>
              <tr><td>{t("权限 / 提问实时应答（input-required）", "Permission / question answering (input-required)")}</td><td>✅</td><td>—</td><td>{t("✅（先答先算，无\"始终允许\"）", "✅ (first answer wins, no \"always allow\")")}</td></tr>
            </tbody>
          </table>
        </section>

        <section id="doc-chat" className="docs-section">
          <h2>{t("即时聊天工具", "Chat apps")}</h2>
          <p>
            <L
              zh={<>把虫群接进你日常使用的聊天工具：在聊天里直接给 agent 派任务、实时围观
                思考与工具调用的时间线，任务完成后收到<b>结果简报</b>，权限请求/AI 提问
                点按钮或回复编号应答。所有设置也可以在网页「账号 → 聊天工具绑定」里管理。</>}
              en={<>Bring the swarm into the chat apps you already use: dispatch tasks to your agent right in chat, follow the timeline of
                reasoning and tool calls, get a <b>result brief</b> when a task finishes, and answer permission requests / AI questions
                by tapping a button or replying with a number. All settings are also managed on the web under "Account → Chat bindings".</>}
            />
          </p>
          <h3>{t("支持的聊天工具", "Supported chat apps")}</h3>
          <table>
            <thead><tr><th>{t("聊天工具", "Chat app")}</th><th>{t("绑定方式", "How to bind")}</th><th>{t("能力", "Capabilities")}</th></tr></thead>
            <tbody>
              <tr>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <FeishuIcon size={18} /> {t("飞书", "Feishu")}
                  </span>
                </td>
                <td><L
                  zh={<>给机器人发 <code>/swarm bind as_你的密钥</code>（密钥在「API Key」页复制）</>}
                  en={<>Send the bot <code>/swarm bind as_your_key</code> (copy the key from the "API Key" page)</>}
                /></td>
                <td>{t("派任务 / 时间线直播 / 完成简报 / 监控同步 / 权限应答",
                  "Dispatch / live timeline / completion briefs / monitor sync / permission answering")}</td>
              </tr>
              <tr>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <WeixinIcon size={18} /> {t("微信 ClawBot", "WeChat ClawBot")}
                  </span>
                </td>
                <td>{t("网页「账号 → 聊天工具绑定 → 微信 ClawBot」扫码登录（用自己的微信号，无需 API Key）",
                  "Log in by QR code at web \"Account → Chat bindings → WeChat ClawBot\" (use your own WeChat account; no API Key needed)")}</td>
                <td>{t("派任务 / 任务详细流 / 完成简报 / 监控同步 / 权限编号应答",
                  "Dispatch / detailed task stream / completion briefs / monitor sync / numbered permission answering")}</td>
              </tr>
            </tbody>
          </table>
          <h3>{t("微信 ClawBot 绑定与使用", "WeChat ClawBot: bind & use")}</h3>
          <ol>
            <li><L
              zh={<>在网页「账号 → 聊天工具绑定」滚动到<b>微信 ClawBot</b> 区块，点<b>扫码登录微信</b></>}
              en={<>On the web go to "Account → Chat bindings", scroll to the <b>WeChat ClawBot</b> section and click <b>Log in by QR code</b></>}
            /></li>
            <li><L
              zh={<>用手机微信扫码（登录流程要求时输入数字配对码），确认后你的微信里出现一个 <b>ClawBot</b> 会话</>}
              en={<>Scan it with WeChat on your phone (enter the numeric pairing code if the login flow asks), and after confirming a <b>ClawBot</b> conversation appears in WeChat</>}
            /></li>
            <li>{t("直接和它聊天即可派任务；扫码登录 token 约 24h 失效，过期后在账号页重新扫码即可",
              "Just chat with it to dispatch tasks; the QR login token expires after about 24h — re-scan on the account page when it does")}</li>
          </ol>
          <p>
            <L
              zh={<>微信<b>无需服务端配置</b>（不同于飞书需要服务端 <code>FEISHU_APP_ID/SECRET</code>）；支持单聊，
                暂无群聊。向 ClawBot 发普通文本 = 给当前选中工作区派任务（未选过会先弹出编号选择列表）。</>}
              en={<>WeChat needs <b>no server-side configuration</b> (unlike Feishu, which needs <code>FEISHU_APP_ID/SECRET</code>); direct chats only,
                no group chats yet. Sending plain text to the ClawBot = dispatching a task to the currently selected workspace (if none was selected, a numbered list pops up first).</>}
            />
          </p>
          <h3>{t("聊天命令", "Chat commands")}</h3>
          <p>
            <L
              zh={<>在聊天窗口里发送以下命令（<code>/swarm</code> + 未知命令会返回一张
                <b>命令菜单卡</b>，按当前状态列出可点按钮，点一下即执行）：</>}
              en={<>Send these commands in the chat window (<code>/swarm</code> plus an unknown command returns a
                <b>command menu card</b> listing clickable buttons for the current state; one tap runs it):</>}
            />
          </p>
          <table>
            <thead><tr><th>{t("命令", "Command")}</th><th>{t("说明", "Description")}</th></tr></thead>
            <tbody>
              <tr><td><code>/swarm bind as_xxx</code></td><td>{t("绑定平台账号（API Key 页复制的密钥）——仅飞书，微信不需要",
                "Bind the platform account (the key copied from the API Key page) — Feishu only; WeChat doesn't need it")}</td></tr>
              <tr><td><code>/swarm unbind</code></td><td>{t("解绑账号（仅飞书；微信在账号页点「断开」）",
                "Unbind the account (Feishu only; for WeChat click \"Disconnect\" on the account page)")}</td></tr>
              <tr><td><code>/q</code> / <code>/swarm</code></td><td>{t("命令菜单（微信侧：回复编号执行；飞书侧：菜单卡点按钮）",
                "Command menu (WeChat: reply with a number; Feishu: tap a button on the card)")}</td></tr>
              <tr><td><code>/swarm list</code></td><td>{t("列出我的工作区（在线/类型）",
                "List my workspaces (online / type)")}</td></tr>
              <tr><td><code>/swarm select</code></td><td>{t("选择当前窗口使用的工作区（下拉卡/编号列表）",
                "Choose the workspace used by this window (dropdown card / numbered list)")}</td></tr>
              <tr><td><code>/swarm status</code></td><td>{t("当前绑定/工作区/监控/简报状态",
                "Current binding / workspace / monitor / brief status")}</td></tr>
              <tr><td><code>/swarm monitor on|off</code></td><td>{t("前台会话实时同步：开启后 TUI 里的对话按时间线推到这个窗口（默认关）",
                "Live foreground sync: once on, TUI conversations are pushed to this window as a timeline (default off)")}</td></tr>
              <tr><td><code>/swarm brief on|off</code></td><td>{t("任务完成简报：工作区的任务（网页/agent/A2A 下发）完成后推一张结果卡片（默认开）",
                "Completion briefs: when a workspace task (dispatched from web / agent / A2A) finishes, push a result card (default on)")}</td></tr>
              <tr><td><code>/swarm last</code></td><td>{t("最近一轮问答摘要（单卡：提问 + 最终回答）",
                "Summary of the most recent Q&A round (single card: question + final answer)")}</td></tr>
              <tr><td><code>/time</code> · <code>/重新连接</code></td><td>{t("微信侧：服务器时间 / 重连 ClawBot 会话",
                "WeChat side: server time / reconnect the ClawBot session")}</td></tr>
            </tbody>
          </table>
          <p>
            <L
              zh={<>微信侧应答规则：有待应答的权限/提问时（输入框上方可能显示编号选项），<b>任何输入都优先作为应答</b>
                （回复 <code>1</code>/<code>2</code>/<code>3</code> 分别 = 允许一次 / 始终允许 / 拒绝；超出 1–3 或非数字 = 允许一次），
                完成后任务继续执行。</>}
              en={<>WeChat answering rules: when a permission/question is pending (numbered options may appear above the input box), <b>any input is treated as the answer first</b>
                (replying <code>1</code>/<code>2</code>/<code>3</code> = allow once / always allow / deny; anything outside 1–3 or non-numeric = allow once),
                after which the task continues.</>}
            />
          </p>
          <h3>{t("两种推送模式", "Two push modes")}</h3>
          <ul>
            <li>
              <L
                zh={<><b>详细流 / 时间线直播（监控模式）</b>——你在 TUI 里和 agent 的对话按轮次推成一组小卡
                  （飞书）；微信则推纯文本：💭 思考过程、🔧 每个工具调用一行（命令/输出）、🤖 最终答复
                  全文，权限请求直接点按钮 / 回复编号应答。</>}
                en={<><b>Detailed stream / live timeline (monitor mode)</b> — your TUI conversation with the agent is pushed round by round as a set of small cards
                  (Feishu); WeChat gets plain text instead: 💭 reasoning, 🔧 one line per tool call (command / output), 🤖 the full final answer,
                  with permission requests answered by tapping a button / replying with a number.</>}
              />
            </li>
            <li>
              <L
                zh={<><b>完成简报（简报模式，默认开）</b>——网页中枢、其他 agent、A2A 外部调用下发的任务
                  完成或失败后，推一张摘要卡（来源/提问/回答）。当前窗口开着监控时，该工作区的监控轮
                  不再重复发简报（时间线已是全程详情）。</>}
                en={<><b>Completion brief (brief mode, default on)</b> — when a task dispatched from the web Nexus, another agent or an external A2A call
                  completes or fails, a summary card is pushed (source / question / answer). When the current window has monitoring on, that workspace's monitor rounds
                  no longer send a separate brief (the timeline is already the full detail).</>}
              />
            </li>
          </ul>
          <p>
            {t("直接发普通文本 = 给当前选中的工作区派任务；未选择工作区时会先弹出选择卡。",
              "Sending plain text = dispatching a task to the currently selected workspace; if none is selected, a selection card pops up first.")}
          </p>
          <p>
            <L
              zh={<><b>跨渠道权限应答</b>：无论权限/提问来自网页中枢还是 TUI 监控轮，只要简报模式开着，
                web / 飞书 / 微信会<b>同时</b>收到提示——谁先应答谁生效，其余渠道的后续应答会干净失败
                （不会重复放行）。</>}
              en={<><b>Cross-channel permission answering</b>: whether the permission/question comes from the web Nexus or a TUI monitor round, as long as brief mode is on,
                web / Feishu / WeChat all receive the prompt <b>at the same time</b> — the first answer wins, and later answers on the other channels fail cleanly
                (no duplicate approval).</>}
            />
          </p>
          <h3>{t("产物推送", "Artifact push")}</h3>
          <p>
            <L
              zh={<>agent 通过 MCP 上传产物后，只要窗口的<b>简报模式开着</b>，你绑定的飞书 / 微信窗口会<b>直接收到文件</b>
                （飞书是原生文件消息；微信优先尝试文件消息，协议不支持时自动降级为下载链接文本），
                并附一条说明（文件名、大小）。下载链接 30 天有效；所有产物也可以在网页「产物」页集中管理。</>}
              en={<>After an agent uploads an artifact over MCP, as long as the window's <b>brief mode is on</b>, your bound Feishu / WeChat window <b>receives the file directly</b>
                (Feishu uses a native file message; WeChat tries a file message first and falls back to a download-link text when the protocol doesn't support it),
                with a note (filename, size). Download links are valid for 30 days; all artifacts can also be managed on the web "Artifacts" page.</>}
            />
          </p>
        </section>

        <section id="doc-mcp" className="docs-section">
          <h2>{t("MCP 工具", "MCP tools")}</h2>
          <p>
            <L
              zh={<>接入后，你的 agent 会获得下面这组 MCP 工具，直接在对话里让它用即可
                （如「用 list_workspaces 看看现在有哪些工作区在线」）。</>}
              en={<>Once connected, your agent gains the MCP tools below; just have it use them in conversation
                (e.g. "use list_workspaces to see which workspaces are online").</>}
            />
          </p>
          <table>
            <thead><tr><th>{t("工具", "Tool")}</th><th>{t("说明", "Description")}</th></tr></thead>
            <tbody>
              <tr><td><code>workspace_add</code></td><td>{t("注册当前目录为工作区，返回 ID 并写入 .agent_swarm/workspace.md",
                "Register the current directory as a workspace, return its ID and write it to .agent_swarm/workspace.md")}</td></tr>
              <tr><td><code>workspace_remove</code></td><td>{t("移除自己的工作区（仅离线可删）",
                "Remove your own workspace (only when offline)")}</td></tr>
              <tr><td><code>workspace_enable</code> / <code>workspace_disable</code></td><td>{t("启用 / 禁用工作区",
                "Enable / disable a workspace")}</td></tr>
              <tr><td><code>heartbeat</code></td><td>{t("心跳保活，上报当前会话信息（插件自动调用）",
                "Heartbeat keep-alive, reports current session info (called automatically by the plugin)")}</td></tr>
              <tr><td><code>update_info</code> / <code>update_notes</code></td><td>{t("更新用途/能力描述、备注",
                "Update the purpose/capability description and comments")}</td></tr>
              <tr><td><code>list_workspaces</code></td><td><L
                zh={<>列出可见工作区（自己的 + 团队共享给你的，默认仅在线；共享项带 <code>shared:true</code>）</>}
                en={<>List visible workspaces (your own + team-shared ones; online only by default; shared entries carry <code>shared:true</code>)</>}
              /></td></tr>
              <tr><td><code>a2a_call</code></td><td>{t("A2A 协议给其他 agent 发任务（内部工作区——自己的或团队共享给你的，或外部 A2A agent 端点）",
                "Dispatch a task to another agent over the A2A protocol (internal workspace — your own or team-shared, or an external A2A agent endpoint)")}</td></tr>
              <tr><td><code>a2a_task</code></td><td>{t("查询 A2A 任务状态与结果",
                "Query A2A task status and result")}</td></tr>
              <tr>
                <td><code>artifact_upload</code></td>
                <td>
                  <L
                    zh={<>上传产物文件（两步）：先调本工具换取一次性上传地址（10 分钟有效），
                      再用 <code>curl -F file=@路径</code> 直传原始字节。<code>workspace_id</code> <b>必填</b>——
                      产物归属该工作区，被共享给团队后团队成员可见（只读）。
                      成功后进入「产物」页并按简报规则推送飞书/微信。单文件上限 20MB，默认保留 7 天</>}
                    en={<>Upload an artifact file (two steps): call this tool to get a one-time upload URL (valid 10 minutes),
                      then push the raw bytes with <code>curl -F file=@path</code>. <code>workspace_id</code> is <b>required</b> —
                      the artifact belongs to that workspace, and once it is shared with a team the members can see it (read-only).
                      On success it appears on the "Artifacts" page and is pushed to Feishu/WeChat per the brief rules. Max 20MB per file, kept 7 days by default</>}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            <L
              zh={<>上表的 <code>/swarm-*</code> 命令（见「命令」章节）就是这些工具的快捷方式。</>}
              en={<>The <code>/swarm-*</code> commands above (see the "Commands" section) are shortcuts for these tools.</>}
            />
          </p>
        </section>

        <section id="doc-web" className="docs-section">
          <h2>{t("Web 管理", "Web console")}</h2>
          <p>
            <L
              zh={<>登录后，顶栏可进入各管理页面（<b>中枢 / 团队 / 工作区 / 调用记录 / 产物</b>，点右上角用户名进账号页），
                日常操作都在网页上完成，不需要记任何命令。</>}
              en={<>Once logged in, the top nav leads to the management pages (<b>Nexus / Teams / Workspaces / Calls / Artifacts</b>; click the username at the top right for the account page),
                and everyday operations happen on the web — no commands to remember.</>}
            />
          </p>
          <h3>{t("中枢", "Nexus")}</h3>
          <p>
            <L
              zh={<>在网页上直接指挥 agent。选择一个在线工作区，输入指令发送，时间线会实时滚动
                agent 的思考过程、工具调用与最终答复。agent 请求权限或向你提问时，直接在时间线里点按钮应答。
                时间线历史持久化保存，刷新页面不丢；点 <code>clear</code> 清空视图，鼠标上滚逐轮加载更早的对话，
                右下角的悬浮按钮可随时跳回最新消息。开启监控模式后，
                你在 agent 里的日常对话也会实时出现在这里。</>}
              en={<>Command agents right from the web. Pick an online workspace, type an instruction and send; the timeline scrolls
                the agent's reasoning, tool calls and final answer in real time. When the agent requests permission or asks a question, answer with a click right in the timeline.
                Timeline history is persisted and survives a refresh; click <code>clear</code> to empty the view, scroll up to load earlier rounds lazily,
                and the floating button at the bottom right jumps back to the latest message. With monitor mode on,
                your everyday conversations with the agent also appear here in real time.</>}
            />
          </p>
          <h3>{t("规划器", "Planner")}</h3>
          <p>
            <L
              zh={<>选中一个规划器工作区后，页面管理它的<b>目标与任务树</b>（安装与使用流程见「规划器」章节）：</>}
              en={<>After selecting a planner workspace, the page manages its <b>goals and task tree</b> (see the "Planner" section for install & usage):</>}
            />
          </p>
          <ul>
            <li><L
              zh={<><b>目标</b>：新建 / 编辑 / 归档（标题、描述、优先级下拉 高/中/低、截止可选、成功标准）。列表标题列显示标题 + 专家；状态列用中文彩色 tag（进行中 / 已归档 + 草稿 / 已通过 + 专家已确认 / 待专家确认）。优先级提交为整数（高=2 / 中=1 / 低=0）、截止为空显示「无截止」。<b>新建表单不含成功标准输入</b>——由专家侧设定 / 确认；仅编辑时可改，改动会置回「待专家确认」。</>}
              en={<><b>Goals</b>: create / edit / archive (title, description, priority dropdown high/medium/low, optional deadline, success criteria). The list's title column shows title + expert; the status column uses colored tags (active / archived + draft / approved + expert-confirmed / awaiting expert confirmation). Priority is submitted as an integer (high=2 / medium=1 / low=0), and an empty deadline shows "no deadline". <b>The create form has no success-criteria input</b> — it is set / confirmed by the expert side; only the edit form can change it, and a change resets it to "awaiting expert confirmation".</>}
            /></li>
            <li><L
              zh={<><b>任务树</b>：选中目标后按依赖层级折叠 / 展开展示任务（状态 / 依赖标题 / 执行 agent 名 / 验收）；<b>点任务标题</b>弹出详情（描述 / 依赖 / 建议与实际执行 agent / 验收类型 / 状态 / 验收结果 / 更新时间）。</>}
              en={<><b>Task tree</b>: after selecting a goal, tasks are shown collapsed / expanded by dependency level (status / dependency titles / executing agent / acceptance); <b>clicking a task title</b> opens details (description / dependencies / suggested and actual agent / acceptance type / status / acceptance result / updated time).</>}
            /></li>
            <li><L
              zh={<><b>操作</b>：<code>催促</code>（让 agent 干活）、<code>通过拆解</code>（仅 <code>draft</code> 时出现）/ <code>重新拆解</code>、<code>通过</code> / <code>拒绝</code>（人工验收）、<code>归档</code> / <code>激活</code> / <code>删除</code>（二次确认）；离线时全部禁用。</>}
              en={<><b>Actions</b>: <code>Nudge</code> (get the agent moving), <code>Approve plan</code> (shown only in <code>draft</code>) / <code>Re-plan</code>, <code>Approve</code> / <code>Reject</code> (manual acceptance), <code>Archive</code> / <code>Activate</code> / <code>Delete</code> (with confirm); all disabled when offline.</>}
            /></li>
            <li><L
              zh={<><b>专家工作区</b>：新建 / 编辑目标时可选专家工作区（自有 + 团队共享，<b>也可选当前规划器工作区自身＝自评审</b>）。指定后由专家拆解任务树并设专家验收点（<code>acceptance_type=expert</code>，状态 <code>waiting_expert</code>）。验收类型：<code>auto</code>「自动验收」/ <code>manual</code>「人工验收」/ <code>expert</code>「专家验收点」；人工「通过 / 拒绝」按钮<b>仅</b> <code>manual</code> 任务显示。</>}
              en={<><b>Expert workspace</b>: when creating / editing a goal you can pick an expert workspace (your own + team-shared, <b>including the planner workspace itself = self-review</b>). Once set, the expert decomposes the task tree and defines expert acceptance points (<code>acceptance_type=expert</code>, status <code>waiting_expert</code>). Acceptance types: <code>auto</code> "auto" / <code>manual</code> "manual" / <code>expert</code> "expert acceptance point"; the manual Approve / Reject buttons appear <b>only</b> on <code>manual</code> tasks.</>}
            /></li>
          </ul>
          <p>
            <L
              zh={<><b>运行前提与排错</b>：规划核心服务必须在线，页面顶部显示在线 / 离线。离线时页面<b>只读</b>——
                只显示最后一次推送的快照（展示缓存，非任务真相），新建 / 编辑 / 审批 / 验收等操作会返回「规划器离线」，
                恢复在线后重试；数据真相在核心服务的本地数据库。页面离线时先确认核心服务在运行；
                派发失败多为目标工作区不可派发（开着 harness，或改用后台模式）。</>}
              en={<><b>Prerequisites & troubleshooting</b>: the planning core service must be online; the top of the page shows online / offline. When offline the page is <b>read-only</b> —
                it shows only the last pushed snapshot (a display cache, not the source of truth), and create / edit / approve / accept actions return "planner offline";
                retry once it is back online. The source of truth lives in the core service's local database. If the page is offline, first check that the core service is running;
                dispatch failures are usually because the target workspace cannot be dispatched to (start its harness, or switch to background mode).</>}
            />
          </p>
          <h3>{t("工作区", "Workspaces")}</h3>
          <p>
            <L
              zh={<>所有已注册工作区的看板：在线状态（30 秒心跳，离线显示最后心跳时间）、
                agent 类型、路径与用途说明。可以启用/禁用工作区（禁用后不参与任务派发）、
                删除离线工作区，支持按名称、路径、用途搜索。<b>我的工作区</b>每行还有「共享到团队」入口。</>}
              en={<>A board of all registered workspaces: online status (30-second heartbeat; offline shows the last heartbeat time),
                agent type, path and purpose description. You can enable/disable workspaces (disabled ones are not dispatched tasks),
                delete offline workspaces, and search by name, path or purpose. Each row of <b>My workspaces</b> also has a "share to team" entry.</>}
            />
          </p>
          <p>
            <L
              zh={<>下方另列<b>共享工作区</b>：队友共享给你的工作区（只读）——显示所有者、共享团队与用途，
                可被你的 agent 通过 <code>a2a_call</code> 调用（只拿最终答复），但你不能启用/禁用/删除，
                也看不到它的监控 / 产物 / 调用细节。</>}
              en={<>Below is a separate <b>Shared workspaces</b> list: workspaces teammates shared with you (read-only) — showing the owner, sharing team and purpose.
                Your agent can call them via <code>a2a_call</code> (getting only the final answer), but you cannot enable/disable/delete them,
                nor see their monitor stream / artifacts / call details.</>}
            />
          </p>
          <h3>{t("调用记录", "Calls")}</h3>
          <p>
            <L
              zh={<>每一次任务派发与每一轮被监控的 TUI 对话的流水账：发起方、目标、指令内容、状态与结果
                （markdown 渲染）。按工作区筛选查看（记住上次选择，cookie 记忆 30 天）：
                跨 agent 调用、网页中枢指令与 <code>[monitor]</code> 监控轮次都在这里，
                已结束的记录可单条删除，也可一键清空该工作区的全部记录；
                <b>进行中</b>的任务可点行尾的「中断（abort）」按钮停止执行（任务置为 cancelled）。</>}
              en={<>A ledger of every task dispatch and every monitored TUI round: caller, target, instruction, status and result
                (rendered as markdown). Filter by workspace (the last choice is remembered via a 30-day cookie):
                cross-agent calls, web Nexus instructions and <code>[monitor]</code> rounds are all here;
                finished records can be deleted one by one or cleared all at once for that workspace;
                an <b>in-progress</b> task can be stopped with the "abort" button at the end of its row (the task becomes cancelled).</>}
            />
          </p>
          <h3>{t("产物", "Artifacts")}</h3>
          <p>
            <L
              zh={<>agent 上传的产出文件集中在这里：文件名（点击直接下载）、大小、上传时间与备注，
                支持搜索。产物默认保留 <b>7 天</b>（过期自动清理）；点📌图钉可<b>固定</b>重要产物，
                固定后不再参与自动清理（仍可手动删除）。上传时也会按简报规则把文件推送到
                你绑定的飞书 / 微信窗口（详见「即时聊天工具 → 产物推送」）。</>}
              en={<>Output files uploaded by agents are collected here: filename (click to download), size, upload time and comment,
                with search. Artifacts are kept <b>7 days</b> by default (auto-cleaned when expired); click the 📌 pin to <b>keep</b> an important one,
                after which it is no longer auto-cleaned (it can still be deleted manually). On upload the file is also pushed to
                your bound Feishu / WeChat window per the brief rules (see "Chat apps → Artifact push").</>}
            />
          </p>
          <p>
            <L
              zh={<>产物<b>归属上传时所在的工作区</b>。该工作区被共享给某个团队后，团队成员可在自己的
                「产物」页看到并下载这份产物（只读：只能下载，不能固定 / 删除）；无归属工作区的产物不参与共享。</>}
              en={<>An artifact <b>belongs to the workspace it was uploaded from</b>. Once that workspace is shared with a team, team members can see and download it
                on their own Artifacts page (read-only: download only, no pin / delete); artifacts with no owning workspace are not shared.</>}
            />
          </p>
          <h3>{t("团队", "Teams")}</h3>
          <p>
            {t("创建团队、按用户名邀请成员，或让他人申请加入（队长审批）；队长可踢人、移交队长、解散团队。一个用户可以同时加入多个团队、管理多个团队。",
              "Create teams, invite members by username, or let others request to join (approved by the captain); the captain can kick members, transfer leadership or disband the team. A user can belong to and manage several teams at once.")}
          </p>
          <p>
            <L
              zh={<>在「工作区」页可把某个工作区<b>共享</b>给自己所在的团队（可一次多选）。共享<strong>只授予调用权，不授予可见权</strong>：
                队友（或用他们的 agent）可对共享工作区发起 <code>a2a_call</code> 并拿到<b>最终答复</b>，
                但看不到它的监控流、思考 / 工具调用、产物详情、简报与调用细节——权限请求也只推给工作区属主。
                被共享的工作区不会出现在队友的中枢 / 工作区列表里；调用记录里双方各自只看得到该条「指令 + 答复」，
                不会暴露监控细节。队友通过 MCP <code>list_workspaces</code>（<code>shared:true</code>）发现共享工作区并调用。</>}
              en={<>On the "Workspaces" page you can <b>share</b> a workspace to a team you belong to (multi-select). Sharing grants <strong>only the right to call, not the right to see</strong>:
                teammates (or their agents) can <code>a2a_call</code> a shared workspace and get the <b>final answer</b>,
                but cannot see its monitor stream, reasoning / tool calls, artifact details, briefs or call details — permission requests go only to the workspace owner.
                A shared workspace does not appear in the teammate's Nexus / workspace list; in call records each side sees only that "instruction + answer" entry,
                with no monitor details. Teammates discover shared workspaces via MCP <code>list_workspaces</code> (<code>shared:true</code>) and call them.</>}
            />
          </p>
          <p>
            <L
              zh={<>团队动态——被邀请、申请/审批结果、有人加入、被移出、移交队长、团队解散——都会记一条<b>站内信</b>；
                顶栏的铃铛显示未读数，点开可查看列表并标记已读（点击某条会跳到「团队」页并打开对应团队）；
                支持<b>全部已读 / 全部删除</b>，每条消息也可用垃圾桶按钮单独删除。</>}
              en={<>Team events — invitations, request / approval results, someone joining, being removed, leadership transfer, team disbanding — each record a <b>notification</b>;
                the bell in the top nav shows the unread count; open it to see the list and mark items read (clicking one jumps to the "Teams" page and opens that team);
                <b>Mark all read / Delete all</b> are supported, and each message can also be deleted individually with the trash button.</>}
            />
          </p>
        </section>

        <section id="doc-faq" className="docs-section">
          <h2>FAQ</h2>
          <h3>{t("权限请求和 AI 提问怎么处理？", "How are permission requests and AI questions handled?")}</h3>
          <p>
            <L
              zh={<>agent 执行中需要授权（如运行命令、写文件）或主动向你提问时，任务进入 <code>input-required</code> 状态：
                目标端的 TUI 会弹出选择框，同时网页中枢时间线出现<b>权限/提问卡片</b>，直接点按钮应答（允许一次 /
                始终允许 / 拒绝，或点选问题选项），agent 立刻继续执行——人和网页谁先响应都可以，另一边会看到结果。
                监控轮次的权限同样支持网页远程应答。注意：后台会话无人值守，权限全自动批准，不走此流程。</>}
              en={<>When an agent needs authorization during execution (e.g. running a command, writing a file) or asks you a question, the task enters <code>input-required</code>:
                the peer's TUI shows a choice dialog, and at the same time a <b>permission/question card</b> appears in the web Nexus timeline where you can click to answer (allow once /
                always allow / deny, or pick a question option), after which the agent continues immediately — whoever answers first wins, and the other side sees the result.
                Monitor-round permissions can also be answered remotely on the web. Note: background sessions are unattended, so permissions are auto-approved and skip this flow.</>}
            />
          </p>
          <h3>{t("任务会出现在对方屏幕上吗？", "Will a task appear on the peer's screen?")}</h3>
          <p>
            <L
              zh={<>取决于目标工作区的执行模式。前台模式下会：任务直接进入对方当前 TUI 会话并弹 toast 通知，实时可见。
                后台模式下不会：任务在独立会话静默执行，网页中枢里同样能实时观看过程。
                用 <code>/swarm-mode</code> 切换。</>}
              en={<>It depends on the target workspace's execution mode. In foreground mode, yes: the task enters the peer's current TUI session with a toast, visible in real time.
                In background mode, no: the task runs silently in an isolated session, though you can still watch it live in the web Nexus.
                Switch with <code>/swarm-mode</code>.</>}
            />
          </p>
          <h3>{t("支持哪些 AI 工具？", "Which AI tools are supported?")}</h3>
          <p>
            <L
              zh={<>我们基于开放协议（MCP + A2A）设计，目标是让<b>所有兼容的 agent 客户端</b>都能加入虫群。
                目前 opencode 与 deepseek harness 全功能支持；claude code 支持注册管理与后台会话任务执行，
                前台注入暂不支持（见「命令」章节的支持情况表）。其它客户端会逐步支持。</>}
              en={<>We design around open protocols (MCP + A2A) so that <b>all compatible agent clients</b> can join the swarm.
                Today opencode and deepseek harness are fully supported; claude code supports registration management and background-session task execution,
                but not foreground injection yet (see the support table in the "Commands" section). More clients are coming.</>}
            />
          </p>
          <h3>{t("claude 工作区能执行任务吗？", "Can a claude workspace execute tasks?")}</h3>
          <p>
            <L
              zh={<>能，但目前仅限<b>后台会话</b>方式：任务在独立会话静默执行，结果自动回传（网页中枢可实时观看）。
                前台注入（任务进入你正在看的会话）还在规划中。</>}
              en={<>Yes, but currently only via <b>background sessions</b>: the task runs silently in an isolated session and the result is returned automatically (watchable live in the web Nexus).
                Foreground injection (a task entering the session you're watching) is still being planned.</>}
            />
          </p>
          <h3>{t("派出去的任务对方跑很久，agent 等不到结果就停了？", "A dispatched task takes a long time and the agent stops before the result?")}</h3>
          <p>
            <L
              zh={<>不会丢。跨工作区任务完成后，若发起方 agent 已经过早收轮（没等到结果），服务端会向它推送一条
                <b>完成提醒</b>——agent 收到后自动调用 <code>a2a_task</code> 取回结果并继续原本的工作；
                发起方离线时提醒排队，上线即送达。你也可以随时手动让 agent「查一下任务 &lt;task_id&gt; 的结果」。</>}
              en={<>It isn't lost. After a cross-workspace task completes, if the calling agent ended its turn too early (didn't wait for the result), the server pushes it a
                <b>completion reminder</b> — the agent then calls <code>a2a_task</code> to fetch the result and resume its work;
                reminders queue while the caller is offline and are delivered when it reconnects. You can also manually ask the agent to "check the result of task &lt;task_id&gt;".</>}
            />
          </p>
          <h3>{t("团队共享的工作区，队友能看到什么？", "What can teammates see of a shared workspace?")}</h3>
          <p>
            <L
              zh={<>只看到<b>最终答复</b>。把自己的工作区共享给团队后，队友（或用他们的 agent）可以像调用工具一样
                <code>a2a_call</code> 它，但看不到监控流、思考 / 工具调用、产物、简报与调用细节；权限请求也只推给你（属主）。
                共享只授予「调用权」，不授予「可见权」，被共享的工作区也不会出现在队友的中枢 / 工作区列表里。</>}
              en={<>Only the <b>final answer</b>. After sharing your workspace with a team, teammates (or their agents) can
                <code>a2a_call</code> it like a tool, but cannot see the monitor stream, reasoning / tool calls, artifacts, briefs or call details; permission requests go only to you (the owner).
                Sharing grants the "right to call", not the "right to see", and a shared workspace does not appear in the teammate's Nexus / workspace list.</>}
            />
          </p>
          <h3>{t("安装后 agent 没出现 / 收不到任务？", "The agent doesn't show up / receives no tasks after install?")}</h3>
          <p>
            <L
              zh={<>重启 opencode 了吗？插件在会话启动时加载，运行中的会话持有旧代码。
                查看 <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code> 可以看到
                心跳与任务领取日志；claude 则查看 <code>~/.claude/agent-swarm/keepalive.log</code>。</>}
              en={<>Did you restart opencode? The plugin loads at session start, and running sessions hold the old code.
                Check <code>~/.config/opencode/plugins/agent-swarm/plugin.log</code> for heartbeat and task-claim logs;
                for claude, check <code>~/.claude/agent-swarm/keepalive.log</code>.</>}
            />
          </p>
          <h3>{t("API Key 忘了 / 想换？", "Forgot your API Key / want to change it?")}</h3>
          <p>
            <L
              zh={<>点击顶部用户名进入「账号 → API Key」，随时查看（默认打码）、复制或重置。
                重置后旧 Key 立即失效，已接入的 agent 需要重新安装或更新配置。
                开启了落库加密时，重置会自动用新 Key 重加密你的历史记录，历史不丢。</>}
              en={<>Click the username at the top to open "Account → API Key" and view (masked by default), copy or reset it anytime.
                Resetting invalidates the old key immediately, and connected agents must be reinstalled or have their config updated.
                With encryption at rest enabled, resetting automatically re-encrypts your history with the new key, so nothing is lost.</>}
            />
          </p>
          <h3>{t("安全吗？", "Is it secure?")}</h3>
          <p>
            {t("所有请求都经过鉴权。跨 agent 任务会注入目标工作区的会话——只把你信任的机器接入虫群。",
              "All requests are authenticated. Cross-agent tasks are injected into the target workspace's session — only join machines you trust to the swarm.")}
          </p>
          <h3>{t("数据是明文存库的吗？", "Is data stored in plaintext?")}</h3>
          <p>
            <L
              zh={<>默认是。在服务器 <code>.env</code> 配置 <code>AGENT_SWARM_ENC_KEY</code> 后开启<b>落库加密</b>：
                工作区描述/备注/会话标题、任务指令/结果/错误、以及中枢事件流原文（含思考与工具调用）都会加密存储，
                管理后台也只能在服务器上解密查看。加密密钥由「服务器密钥 + 你的 API Key」联合派生——
                泄露数据库文件本身无法解密内容。
                <b>注意</b>：不配置该密钥则全部明文落库；密钥一旦丢失，已加密的历史内容将永久无法读取（平台本身不受影响），
                请务必备份。可选配置 <code>AGENT_SWARM_ENC_KEY_RECOVERY</code> 恢复密钥兜底。</>}
              en={<>By default, yes. Configure <code>AGENT_SWARM_ENC_KEY</code> in the server's <code>.env</code> to enable <b>encryption at rest</b>:
                workspace descriptions/comments/session titles, task instructions/results/errors, and the raw Nexus event stream (including reasoning and tool calls) are stored encrypted,
                and even the admin console can only decrypt them on the server. The key is derived jointly from the "server key + your API Key" —
                leaking the database file alone cannot decrypt the content.
                <b>Note</b>: without that key everything is stored in plaintext; and once the key is lost, already-encrypted history can never be read again (the platform itself is unaffected),
                so be sure to back it up. You can optionally set <code>AGENT_SWARM_ENC_KEY_RECOVERY</code> as a recovery key.</>}
            />
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
export function NexusWorkspaceSelect({ list, value, onChange, showOwner }: {
  list: Array<{ id: string; name: string; path: string; agent_type?: string | null; owner?: string | { username: string } | null }>
  value: string
  onChange: (id: string) => void
  showOwner?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // 菜单弹出方向/高度：在容器（弹窗优先）内测量可用空间，空间不足则向上弹，避免撑出滚动条
  const [menuPos, setMenuPos] = useState<{ up: boolean; maxHeight: number }>({ up: false, maxHeight: 320 })
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const box = (el.closest(".dialog") as HTMLElement | null) ?? document.documentElement
      const b = box.getBoundingClientRect()
      const below = b.bottom - r.bottom
      const above = r.top - b.top
      const up = below < 220 && above > below
      setMenuPos({ up, maxHeight: Math.max(140, Math.min(320, (up ? above : below) - 24)) })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [open])
  const current = list.find((w) => w.id === value)
  const ownerName = (w: { owner?: string | { username: string } | null }) =>
    typeof w.owner === "string" ? w.owner : w.owner?.username || ""

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
            {showOwner && ownerName(current) ? <span className="nexus-select-item-path">@{ownerName(current)}</span> : null}
          </>
        ) : (
          <span className="nexus-select-placeholder">{t("选择工作区…", "Select a workspace…")}</span>
        )}
        <svg className="nexus-select-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          className={`nexus-select-menu${menuPos.up ? " open-up" : ""}`}
          style={{ maxHeight: menuPos.maxHeight }}
        >
          {list.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-weak)" }}>
              {t("暂无工作区", "No workspaces")}
            </div>
          ) : list.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`nexus-select-item${w.id === value ? " selected" : ""}`}
              onClick={() => { onChange(w.id); setOpen(false) }}
            >
              <AgentTypeIcon type={w.agent_type} />
              <span className="nexus-select-item-name">{w.name}{showOwner && ownerName(w) ? ` @${ownerName(w)}` : ""}</span>
              <span className="nexus-select-item-path">{w.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NexusPage({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
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
          toast(t("WS 鉴权失败，请重新登录", "WebSocket auth failed, please log in again"))
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
      setItems((prev) => {
        const next = [...prev]
        const i = next.findIndex((it) => it.key === key)
        // 合并而非覆盖：result 帧只带 output 不带 input/工具名，直接覆盖会把 IN 冲掉
        const base = i >= 0 ? next[i] : { key, kind: "tool" as const, text: "", time: Date.now() }
        const entry: TimelineItem = {
          ...base,
          text: cmd || base.text,
          tool: String(meta.tool ?? "") || base.tool,
          state: String(meta.tool_state ?? "running"),
          output: typeof meta.output === "string" ? meta.output : base.output,
          time: Date.now(),
        }
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
              text: String(data?.question ?? t("请选择", "Please choose")),
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
        { key: `idle-${evt.taskId}-${prev.length}`, kind: "idle", text: t("已完成", "Done"), time: Date.now() },
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
      setItems((prev) => {
        const next = [...prev]
        const i = next.findIndex((it) => it.key === key)
        // 合并而非覆盖：result 帧只带 output，覆盖会把 running 行的 IN 冲掉
        const base = i >= 0 ? next[i] : { key, kind: "tool" as const, text: "", time: Date.now() }
        const entry: TimelineItem = {
          ...base,
          text: toolCommand(p.input as Record<string, unknown> | undefined) || base.text,
          tool: String(p.tool ?? "") || base.tool,
          state: String(p.toolState ?? "running"),
          output: typeof p.output === "string" ? p.output : base.output,
          time: Date.now(),
        }
        if (i >= 0) next[i] = entry
        else next.push(entry)
        // 同轮出现【新的 running 工具】= agent 已越过权限等待（多半在 TUI 里选过了）：
        // 把该轮未应答的 permission/question 条目自动标记，避免残留可点按钮。
        // 只认 running 态——completed 是等待期此前工具的收尾快照，不能作为"已越过"的证据。
        if (entry.state !== "running") return next
        return next.map((it) =>
          !it.answered && it.task_id === round && (it.kind === "permission" || it.kind === "question")
            ? { ...it, answered: "tui" }
            : it,
        )
      })
      return
    }
    if (mtype === "text" || mtype === "reasoning") {
      const partId = String(p.partId ?? p.part_id ?? "")
      const key = `${mtype === "reasoning" ? "r" : "t"}-${partId || round}`
      const kind = mtype === "reasoning" ? "reasoning" : "text"
      // mode: "append"=增量 delta（opencode V2）→ 拼接累积；
      //       "replace"/缺省=全量快照（V1 / dsh）→ 覆盖（旧插件无 mode 走此分支）
      const appendMode = p.mode === "append"
      setItems((prev) => {
        const next = [...prev]
        const i = next.findIndex((it) => it.key === key)
        const incoming = String(p.text ?? "")
        if (i >= 0) {
          next[i] = {
            ...next[i],
            text: appendMode ? (next[i].text ?? "") + incoming : incoming,
            time: Date.now(),
          }
        } else {
          next.push({ key, kind, text: incoming, time: Date.now() })
        }
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
                text: String(p.question ?? t("请选择", "Please choose")),
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
        return [...prev, { key, kind: "idle", text: t("已完成", "Done"), time: Date.now() }]
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
    if (!pluginOnline) { toast(t("目标工作区插件不在线", "The target workspace plugin is offline")); return }
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
        toast(`${t("下发失败", "Send failed")}: ${e.message}`)
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
        put({ key: `ques-${requestId}`, kind: "question", text: String(data?.question ?? t("请选择", "Please choose")), options: (Array.isArray(data?.options) ? data.options : []) as Array<{ label: string; value: string }>, request_id: requestId, task_id: evt.taskId, time: 0 })
      }
      return
    }
    if (state === "completed") {
      put({ key: `idle-${evt.taskId}`, kind: "idle", text: t("已完成", "Done"), time: 0 })
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
          : { key, kind: "question", text: String(p.question ?? t("请选择", "Please choose")), options: (Array.isArray(p.options) ? p.options : []) as Array<{ label: string; value: string }>, request_id: requestId, task_id: round, time: 0 },
      )
      return
    }
    if (mtype === "idle") {
      put({ key: `idle-${round}`, kind: "idle", text: t("已完成", "Done"), time: 0 })
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
      <h1 className="page-title">{t("中枢", "Nexus")}</h1>
      <p className="page-sub">{t("选择一个在线工作区直接下达指令，实时查看 agent 的思考、工具调用与答复。",
        "Pick an online workspace and send instructions directly; watch the agent's reasoning, tool calls and answers in real time.")}</p>

      <div className="nexus-picker">
        <NexusWorkspaceSelect
          list={onlineList}
          value={selected}
          onChange={setSelected}
        />
        {!onlineList.length && <span className="nexus-empty">{t("暂无在线工作区 — 等待插件心跳上线",
          "No online workspaces yet — waiting for plugins to heartbeat online")}</span>}
      </div>

      {selected && (
        <div className={`nexus-terminal ${agentToolKind(current?.agent_type) === "opencode" ? "tui" : agentToolKind(current?.agent_type) === "deepseek" ? "dsh-ui" : "claude-tui"}`}>
          <div className="nexus-terminal-head">
            <AgentTypeIcon type={current?.agent_type} inherit />
            <span className="nexus-head-title">{current?.name ?? selected}</span>
            {current?.session_title && (
              <span className="nexus-head-session" title={current.session_title}>{current.session_title}</span>
            )}
            <span className={`nexus-head-status ${pluginOnline ? "on" : "off"}`}>{pluginOnline ? "● online" : "○ offline"}</span>
            <span style={{ flex: 1 }} />
            <button className="nexus-head-clear" title={t("清空视图（服务端历史保留，上滚可重新加载）",
              "Clear the view (server history is kept; scroll up to reload)")} onClick={clearHistory}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18" />
                <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
              {t("清空", "clear")}
            </button>
          </div>
          <div className="nexus-timeline-wrap">
            <div className="nexus-timeline" ref={timelineRef} onScroll={onTimelineScroll}>
              {!items.length && (
                <div className="nexus-waiting">{t("等待输入 — 输入指令开始", "waiting for input — type a command to start")}</div>
              )}
              {items.map((it) => (
                <TimelineEntrySwitch
                  key={it.key}
                  item={it}
                  agentType={current?.agent_type}
                  onPermissionReply={(reqId, reply) => {
                    api.replyTask(selected, it.task_id ?? "", { type: "permission", request_id: reqId, reply })
                      .catch((e: Error) => toast(`${t("应答失败", "Reply failed")}: ${e.message}`))
                    markAnswered(it.key, reply)
                  }}
                  onQuestionReply={(reqId, answers) => {
                    api.replyTask(selected, it.task_id ?? "", { type: "question", request_id: reqId, answers })
                      .catch((e: Error) => toast(`${t("应答失败", "Reply failed")}: ${e.message}`))
                    markAnswered(it.key, answers[0]?.[0] ?? "")
                  }}
                />
              ))}
              {busy && (
                <div className="nexus-statusline">
                  <span className="nexus-spinner">✳</span>
                  <span className="nexus-status-text">{t("处理中…", "Working…")}</span>
                  <span className="nexus-status-dim">{t("(nexus-web · 在 TUI 里按 esc 中断)", "(nexus-web · esc to interrupt in TUI)")}</span>
                </div>
              )}
            </div>
            {showJumpBtn && (
              <button className="nexus-jump-bottom" title={t("滚动到底部", "Scroll to bottom")} onClick={jumpToBottom}>
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
              placeholder={pluginOnline ? t("给这个 agent 输入指令", "type a command for this agent") : t("插件离线 — 仅可查看历史", "plugin offline — history only")}
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
            <button className="nexus-send" onClick={send} disabled={!pluginOnline || busy || !input.trim()}>{t("发送 ⏎", "send ⏎")}</button>
          </div>
          <div className="nexus-footer">
            <div className="nexus-footer-path" title={current?.session_title ? `${t("会话", "Session")}: ${current.session_title}` : undefined}>
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
              <span>{t("目标", "target")}: {current?.name ?? selected}</span>
              <span className="nexus-footer-dim">·</span>
              <span>{busy ? t("agent 运行中…", "agent running…") : t("agent 空闲", "agent idle")}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** timeline 条目渲染入口：按 agent 类型分发控件
 *  opencode → OpencodeTuiEntry（TUI 黑底终端风格）
 *  claude → ClaudeTuiEntry（claude code CLI 时间线风格）
 *  deepseek → DshEntry（dsh web UI 风格：蓝泡用户消息 + think 行 + 工具行/IO 卡）
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
  if (kind === "deepseek") return <DshEntry {...props} />
  return <TimelineEntry {...props} />
}

// ---------------- dsh 中枢控件（模仿 deepseek harness web UI） ----------------

/** dsh 工具行摘要：工具名 · 摘要（视觉上由 2px 圆点分隔） */
function dshToolSummary(item: TimelineItem): string {
  return truncateLine(item.text ?? "", 96)
}

/** dsh 时间线条目：用户消息右对齐蓝色气泡（dsw-specific-bubble），
 *  thinking/工具 = DisclosureRow 形态（图标 + 标题 + 点分隔摘要，展开出正文/IO 卡）。 */
function DshEntry({ item, onPermissionReply, onQuestionReply }: {
  item: TimelineItem
  onPermissionReply?: (requestId: string, reply: "once" | "always" | "reject") => void
  onQuestionReply?: (requestId: string, answers: string[][]) => void
}) {
  const { t } = useI18n()
  if (item.kind === "user") {
    // 用户消息：右对齐蓝色气泡（对齐 dsh MessageItem 的 bubble 形态）
    return (
      <div className="dsh-userRow">
        <div className="dsh-bubble">{item.text}</div>
      </div>
    )
  }
  if (item.kind === "idle") {
    return null
  }
  if (item.kind === "error") {
    return (
      <div className="dsh-turnError">
        <span className="dsh-turnErrorDot" />
        <div className="dsh-turnErrorCopy">
          <span className="dsh-turnErrorTitle">{t("出错了", "Error")}</span>
          <span className="dsh-turnErrorMessage">{item.text}</span>
        </div>
      </div>
    )
  }
  if (item.kind === "reasoning") {
    // thinking：think 图标 + 标题「思考中/已深度思考」+ 首行摘要，展开全文
    const running = false
    const summary = truncateLine((item.text ?? "").replace(/\*\*/g, "").split("\n").find((l) => l.trim()) ?? "", 88)
    return (
      <details className="dsh-row">
        <summary className="dsh-rowHead">
          <span className="dsh-rowIcon dsh-think">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5.9 1.1 1 1.8l.1.4h5l.1-.4c.1-.7.4-1.3 1-1.8A6 6 0 0 0 12 3Z" />
              <path d="M10 19h4" />
              <path d="M10.5 22h3" />
            </svg>
          </span>
          <span className="dsh-rowTitle">{running ? t("思考中", "Thinking") : t("已深度思考", "Thought it through")}</span>
          <span className="dsh-rowSep" />
          <span className="dsh-rowSummary">{summary}</span>
        </summary>
        <div className="dsh-thinkBody">{item.text}</div>
      </details>
    )
  }
  if (item.kind === "tool") {
    const running = item.state === "running"
    const failed = item.state === "error"
    const output = item.output?.trim() ?? ""
    return (
      <details className="dsh-row" data-error={failed || undefined} open={running || undefined}>
        <summary className="dsh-rowHead">
          <span className={`dsh-rowIcon${failed ? " err" : ""}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L15 12l-3-3 2.7-2.7Z" />
            </svg>
          </span>
          <span className="dsh-rowTitle">{item.tool ?? "tool"}</span>
          <span className="dsh-rowSep" />
          <span className={`dsh-rowSummary${failed ? " err" : ""}`}>
            {running ? <span className="dsh-shimmer">{dshToolSummary(item)}</span> : dshToolSummary(item)}
          </span>
        </summary>
        {(output || dshToolSummary(item)) && (
          <div className={`dsh-ioCard${failed ? " err" : ""}`}>
            <div className="dsh-ioSection">
              <span className="dsh-ioLabel">IN</span>
              <span className="dsh-ioText">{dshToolSummary(item)}</span>
            </div>
            {output && (
              <>
                <div className="dsh-ioDivider" />
                <div className="dsh-ioSection">
                  <span className="dsh-ioLabel">OUT</span>
                  <span className="dsh-ioText" data-error={failed || undefined}>{output}</span>
                </div>
              </>
            )}
          </div>
        )}
      </details>
    )
  }
  if (item.kind === "permission") {
    if (item.answered) {
      return (
        <div className="dsh-turnError">
          <span className="dsh-turnErrorDot ok" />
          <div className="dsh-turnErrorCopy">
            <span className="dsh-turnErrorMessage">{t("权限已", "Permission ")}{permAnswerLabel(item.answered!, t)}{t("：", ": ")}{item.permission}</span>
          </div>
        </div>
      )
    }
    return (
      <div className="dsh-askCard">
        <div className="dsh-askTitle">{t("权限请求", "Permission request")}</div>
        <div className="dsh-askBody">{item.permission}{item.text ? ` — ${item.text}` : ""}</div>
        <div className="dsh-askActions">
          {/* dsh 的 ApprovalOutcome 只有 allowed-once/rejected——没有"始终允许" */}
          <button className="dsh-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "once")}>{t("允许一次", "allow once")}</button>
          <button className="dsh-ask-btn danger" onClick={() => onPermissionReply?.(item.request_id!, "reject")}>{t("拒绝", "reject")}</button>
        </div>
      </div>
    )
  }
  if (item.kind === "question") {
    if (item.answered) {
      return (
        <div className="dsh-turnError">
          <span className="dsh-turnErrorDot ok" />
          <div className="dsh-turnErrorCopy">
            <span className="dsh-turnErrorMessage">{t("已选择：", "Selected: ")}<b>{item.answered}</b></span>
          </div>
        </div>
      )
    }
    return (
      <div className="dsh-askCard">
        <div className="dsh-askTitle">{t("需要你的选择", "Your choice is needed")}</div>
        <div className="dsh-askBody">{item.text}</div>
        <div className="dsh-askActions">
          {(item.options ?? []).map((o) => (
            <button key={o.value} className="dsh-ask-btn" onClick={() => onQuestionReply?.(item.request_id!, [[o.value]])}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  // agent 回答：markdown 正文（无气泡，dsh 的 assistant 文本是通栏排版）
  return (
    <div className="dsh-assistant"><Md text={item.text} /></div>
  )
}

/** 兜底默认控件：气泡风格（通用，不依赖具体 agent 工具的视觉习惯） */
function TimelineEntry({ item, onPermissionReply, onQuestionReply }: {
  item: TimelineItem
  onPermissionReply?: (requestId: string, reply: "once" | "always" | "reject") => void
  onQuestionReply?: (requestId: string, answers: string[][]) => void
}) {
  const { t } = useI18n()
  if (item.kind === "user") {
    return (
      <div className="tl-item tl-user">
        <div className="tl-role">{t("你", "You")}</div>
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
        <div className="tl-role">{t("错误", "Error")}</div>
        <div className="tl-bubble">{item.text}</div>
      </div>
    )
  }
  if (item.kind === "reasoning") {
    return (
      <details className="tl-item tl-reasoning">
        <summary>{t("思考过程", "Reasoning")}</summary>
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
      return <div className="tl-item tl-idle">✓ {t("权限已", "Permission ")}{permAnswerLabel(item.answered!, t)}</div>
    }
    return (
      <div className="tl-item tl-ask">
        <div className="tl-ask-head">🔐 {t("权限请求", "Permission request")}{t("：", ": ")}{item.permission}</div>
        {item.text && <div className="tl-ask-body">{item.text}</div>}
        <div className="tl-ask-actions">
          <button className="tl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "once")}>{t("允许一次", "allow once")}</button>
          <button className="tl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "always")}>{t("始终允许", "always allow")}</button>
          <button className="tl-ask-btn danger" onClick={() => onPermissionReply?.(item.request_id!, "reject")}>{t("拒绝", "reject")}</button>
        </div>
      </div>
    )
  }
  if (item.kind === "question") {
    if (item.answered) {
      return <div className="tl-item tl-idle">✓ {item.answered === "tui" ? t("已在 TUI 处理", "Handled in TUI") : item.answered ? `${t("已选择：", "Selected: ")}${item.answered}` : t("已选择", "Selected")}</div>
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
  const { t } = useI18n()
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
        <summary>{t("思考片刻（点击展开）", "Thought for a bit (click to expand)")}</summary>
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
          {t("权限已", "Permission ")}{permAnswerLabel(item.answered!, t)}{t("：", ": ")}{item.permission}
        </div>
      )
    }
    return (
      <div className="tl-ask">
        <div className="tl-ask-head"><span className="tl-ask-glyph">🔐</span> {t("权限请求", "Permission request")}{t("：", ": ")}<b>{item.permission}</b></div>
        {item.text && <div className="tl-ask-body">{item.text}</div>}
        <div className="tl-ask-actions">
          <button className="tl-ask-btn primary" onClick={() => onPermissionReply?.(item.request_id!, "once")}>{t("允许一次", "allow once")}</button>
          <button className="tl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "always")}>{t("始终允许", "always allow")}</button>
          <button className="tl-ask-btn danger" onClick={() => onPermissionReply?.(item.request_id!, "reject")}>{t("拒绝", "reject")}</button>
        </div>
      </div>
    )
  }
  if (item.kind === "question") {
    if (item.answered) {
      return (
        <div className="tl-ask-done">
          <span className="tl-ask-glyph">❓</span> {item.answered === "tui" ? t("已在 TUI 处理", "Handled in TUI") : <>{t("已选择：", "Selected: ")}<b>{item.answered}</b></>}
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
function permAnswerLabel(answered: string, t: (zh: string, en: string) => string): string {
  if (answered === "tui") return t("已在 TUI 处理", "handled in TUI")
  if (answered === "reject") return t("拒绝", "rejected")
  const label = answered === "once" ? t("一次", "once") : answered === "always" ? t("始终", "always") : answered
  return t(`允许（${label}）`, `allowed (${label})`)
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
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const LONG = 600 // 超过此长度视为超长输出
  const isLong = output.length > LONG
  return (
    <div className="tl-tool-output-wrap">
      <pre className={`tl-tool-output${isLong ? (expanded ? " expanded" : " clamped") : ""}`}>{output}</pre>
      {isLong && !expanded && (
        <button className="tl-tool-expand" onClick={() => setExpanded(true)}>{t("展开", "expand")}</button>
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
function claudeReadonlySummary(item: TimelineItem, t: (zh: string, en: string) => string): string | null {
  const tool = (item.tool ?? "").toLowerCase()
  const n = (item.output ?? "").split("\n").filter((l) => l.trim()).length
  if (["read", "view"].includes(tool)) return t(`读取 ${n || 1} 行`, `Read ${n || 1} line${n === 1 ? "" : "s"}`)
  if (["glob", "grep", "list"].includes(tool)) return t(`找到 ${n} 项`, `Found ${n} entr${n === 1 ? "y" : "ies"}`)
  return null
}

/** claude 时间线条目：> 用户（左对齐） / ● 大点 agent·tool·thinking / ⎿ 工具输出，无框 */
function ClaudeTuiEntry({ item, onPermissionReply, onQuestionReply }: {
  item: TimelineItem
  onPermissionReply?: (requestId: string, reply: "once" | "always" | "reject") => void
  onQuestionReply?: (requestId: string, answers: string[][]) => void
}) {
  const { t } = useI18n()
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
          <span className="cl-fold-label">{t("思考片刻", "Thought for a bit")}</span>
          <span className="cl-expand">{t("展开", "expand")}</span>
        </summary>
        <div className="cl-entry-body">
          <div className="cl-fold-body">{item.text}</div>
        </div>
      </details>
    )
  }
  if (item.kind === "tool") {
    const running = item.state === "running"
    const readonly = claudeReadonlySummary(item, t)
    const output = item.output?.trim() ?? ""
    // list/read 类：一行摘要（完成后替换为 Found/Read 行），expand 展开完整输出
    if (readonly && !running && output) {
      return (
        <details className="cl-entry cl-fold">
          <summary>
            <span className="cl-dot">●</span>
            <span className="cl-fold-label">{readonly}</span>
            <span className="cl-expand">{t("展开", "expand")}</span>
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
            {t("权限已", "Permission ")}{permAnswerLabel(item.answered!, t)}{t("：", ": ")}{item.permission}
          </div>
        </div>
      )
    }
    return (
      <div className="cl-entry">
        <span className="cl-dot">●</span>
        <div className="cl-entry-body">
          <div className="cl-ask-head">{t("权限请求", "Permission request")}{t("：", ": ")}<b>{item.permission}</b></div>
          {item.text && <div className="cl-ask-body">{item.text}</div>}
          <div className="cl-ask-actions">
            <button className="cl-ask-btn primary" onClick={() => onPermissionReply?.(item.request_id!, "once")}>{t("允许一次", "allow once")}</button>
            <button className="cl-ask-btn" onClick={() => onPermissionReply?.(item.request_id!, "always")}>{t("始终允许", "always allow")}</button>
            <button className="cl-ask-btn danger" onClick={() => onPermissionReply?.(item.request_id!, "reject")}>{t("拒绝", "reject")}</button>
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
          <div className="cl-entry-body">{item.answered === "tui" ? t("已在 TUI 处理", "Handled in TUI") : <>{t("已选择：", "Selected: ")}<b>{item.answered}</b></>}</div>
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
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const isLong = output.split("\n").length > 8 || output.length > 400
  return (
    <div className="cl-hook-wrap">
      <pre className={`cl-hook-output${isLong && !expanded ? " clamped" : ""}`}>{output}</pre>
      {isLong && !expanded && (
        <button className="cl-expand" onClick={() => setExpanded(true)}>{t("展开", "expand")}</button>
      )}
    </div>
  )
}

// ---------------- 工作区 ----------------

function TeamsPage({ toast, openTeamId, onConsumeOpenTeam }: { toast: (m: string) => void; openTeamId?: string | null; onConsumeOpenTeam?: () => void }) {
  const { t } = useI18n()
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [inv, setInv] = useState<TeamInvitations>({ invites: [], requests: [] })
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [me, setMe] = useState<User | null>(null)
  const [busy, setBusy] = useState(false)

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [newPolicy, setNewPolicy] = useState("approval")

  const [showBrowse, setShowBrowse] = useState(false)
  const [discover, setDiscover] = useState<DiscoveredTeam[]>([])
  const [dq, setDq] = useState("")

  const [inviteName, setInviteName] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [t, i] = await Promise.all([api.teams(), api.teamInvitations()])
      setTeams(t.teams)
      setInv(i)
    } catch (e: any) { toast(e.message) }
  }, [toast])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { api.me().then(setMe).catch(() => {}) }, [])

  // 站内信点击跳转：自动打开指定团队详情（消费后清空，避免返回时重复弹）
  useEffect(() => {
    if (!openTeamId) return
    api.teamDetail(openTeamId).then(setDetail).catch((e: any) => toast(e.message))
    onConsumeOpenTeam?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTeamId])

  // 详情打开时轮询刷新（成员/待审批实时些）
  useEffect(() => {
    const id = detail?.id
    if (!id) return
    const timer = setInterval(async () => {
      try { setDetail(await api.teamDetail(id)) } catch { /* ignore */ }
    }, 5000)
    return () => clearInterval(timer)
  }, [detail?.id])

  useEffect(() => {
    if (!showBrowse) return
    let alive = true
    api.discoverTeams(dq).then((r) => { if (alive) setDiscover(r.teams) }).catch(() => {})
    return () => { alive = false }
  }, [showBrowse, dq])

  const act = async (fn: () => Promise<unknown>, msg: string, close = false) => {
    setBusy(true)
    try {
      await fn()
      toast(msg)
      if (close) setDetail(null)
      else if (detail) {
        try { setDetail(await api.teamDetail(detail.id)) } catch { setDetail(null) }
      }
      await refresh()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }

  const openDetail = async (id: string) => {
    try { setDetail(await api.teamDetail(id)) } catch (e: any) { toast(e.message) }
  }

  const createTeam = async () => {
    if (!newName.trim()) { toast(t("请输入团队名", "Please enter a team name")); return }
    setBusy(true)
    try {
      await api.createTeam({ name: newName.trim(), join_policy: newPolicy })
      toast(t("团队已创建", "Team created"))
      setShowCreate(false); setNewName(""); setNewPolicy("approval")
      await refresh()
    } catch (e: any) { toast(e.message) } finally { setBusy(false) }
  }

  const policyLabel = (p: string) => ({
    approval: t("审批加入", "Approval"),
    open: t("开放加入", "Open"),
    closed: t("禁止加入", "Invite only"),
  } as Record<string, string>)[p] ?? p
  const memberLabel = (m: TeamMemberInfoLike) =>
    m.status === "active" ? t("成员", "member") : m.kind === "invite" ? t("待接受邀请", "invite pending") : t("待审批申请", "request pending")

  const hasInv = inv.invites.length + inv.requests.length > 0

  return (
    <>
      <h1 className="page-title">{t("团队", "Teams")}</h1>
      <p className="page-sub">
        <L
          zh={<>创建团队、邀请成员，并把工作区共享给团队当工具调用——团队成员可对其 a2a_call，
            只拿最终答复，看不到监控 / 产物 / 调用细节。</>}
          en={<>Create teams, invite members, and share workspaces to the team as callable tools — team members can a2a_call them
            and get only the final answer, without seeing monitoring / artifacts / call details.</>}
        />
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Btn onClick={() => setShowCreate(true)}>{t("+ 创建团队", "+ Create team")}</Btn>
        <Btn variant="ghost" onClick={() => setShowBrowse(true)}>{t("申请加入团队", "Request to join a team")}</Btn>
      </div>

      {hasInv && (
        <>
          <h3 style={{ margin: "8px 0" }}>{t("待处理", "Pending")}</h3>
          <table className="grid">
            <thead>
              <tr><th style={{ width: 70 }}>{t("类型", "Type")}</th><th style={{ width: 200 }}>{t("团队", "Team")}</th><th>{t("对方", "Counterparty")}</th><th style={{ width: 170 }}>{t("操作", "Actions")}</th></tr>
            </thead>
            <tbody>
              {inv.invites.map((v, i) => (
                <tr key={"inv" + i}>
                  <td>{t("邀请", "Invite")}</td>
                  <td className="strong">{v.team.name}</td>
                  <td>{v.invited_by.username} {t("邀请你加入", "invited you to join")}</td>
                  <td>
                    <Btn size="sm" disabled={busy || !me} onClick={() => act(() => api.decideMembership(v.team.id, me!.id, "accept"), t("已加入", "Joined"))}>{t("接受", "Accept")}</Btn>{" "}
                    <Btn size="sm" variant="ghost" disabled={busy || !me} onClick={() => act(() => api.decideMembership(v.team.id, me!.id, "reject"), t("已拒绝", "Rejected"))}>{t("拒绝", "Reject")}</Btn>
                  </td>
                </tr>
              ))}
              {inv.requests.map((v, i) => (
                <tr key={"req" + i}>
                  <td>{t("申请", "Request")}</td>
                  <td className="strong">{v.team.name}</td>
                  <td>{v.user.username} {t("申请加入", "requested to join")}</td>
                  <td>
                    <Btn size="sm" disabled={busy} onClick={() => act(() => api.decideMembership(v.team.id, v.user.id, "accept"), t("已通过", "Approved"))}>{t("通过", "Approve")}</Btn>{" "}
                    <Btn size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.decideMembership(v.team.id, v.user.id, "reject"), t("已拒绝", "Rejected"))}>{t("拒绝", "Reject")}</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 style={{ margin: "16px 0 8px" }}>{t("我的团队", "My teams")}</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>{t("名称", "Name")}</th>
            <th style={{ width: 160 }}>{t("队长", "Leader")}</th>
            <th style={{ width: 70 }}>{t("成员", "Members")}</th>
            <th style={{ width: 100 }}>{t("共享工作区", "Shared workspaces")}</th>
            <th style={{ width: 110 }}>{t("加入方式", "Join policy")}</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((team) => (
            <tr key={team.id}>
              <td className="strong">
                <a className="link" onClick={() => openDetail(team.id)}>{team.name}</a>
                {team.is_leader && <span className="status-pill accepted" style={{ marginLeft: 6 }}>{t("队长", "leader")}</span>}
                {team.is_leader && team.pending_count > 0 && <span title={t("待审批申请", "Pending join requests")} style={{ marginLeft: 6, color: "var(--accent, #e6a23c)" }}>● {team.pending_count}</span>}
              </td>
              <td>{team.leader.username}</td>
              <td>{team.member_count}</td>
              <td>{team.workspace_count}</td>
              <td style={{ color: "var(--text-weak)", fontSize: 12 }}>{policyLabel(team.join_policy)}</td>
            </tr>
          ))}
          {!teams.length && (
            <tr><td colSpan={5} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
              {t("[*] 暂无团队 — 创建一个，或申请加入", "[*] No teams yet — create one, or request to join")}
            </td></tr>
          )}
        </tbody>
      </table>

      {showCreate && (
        <Modal title={t("创建团队", "Create team")} onClose={() => setShowCreate(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>{t("团队名", "Team name")}
              <input className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("如：前端组", "e.g. Frontend team")} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>{t("加入方式", "Join policy")}
              <select className="field" value={newPolicy} onChange={(e) => setNewPolicy(e.target.value)}>
                <option value="approval">{t("审批加入（我审核申请）", "Approval (I review requests)")}</option>
                <option value="open">{t("开放加入（无需审核）", "Open (no approval needed)")}</option>
                <option value="closed">{t("禁止加入（仅邀请）", "Invite only")}</option>
              </select>
            </label>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setShowCreate(false)}>{t("取消", "Cancel")}</Btn>
            <Btn size="sm" disabled={busy} onClick={createTeam}>{t("创建", "Create")}</Btn>
          </div>
        </Modal>
      )}

      {showBrowse && (
        <Modal wide title={t("申请加入团队", "Request to join a team")} onClose={() => setShowBrowse(false)}>
          <SearchBox value={dq} onChange={setDq} placeholder={t("搜索团队名…", "Search team name…")} />
          <div style={{ maxHeight: 320, overflow: "auto", marginTop: 8 }}>
            <table className="grid">
              <thead><tr><th>{t("名称", "Name")}</th><th style={{ width: 140 }}>{t("队长", "Leader")}</th><th style={{ width: 70 }}>{t("成员", "Members")}</th><th style={{ width: 90 }}>{t("加入方式", "Join policy")}</th><th style={{ width: 90 }}></th></tr></thead>
              <tbody>
                {discover.map((team) => (
                  <tr key={team.id}>
                    <td className="strong">{team.name}</td>
                    <td>{team.leader.username}</td>
                    <td>{team.member_count}</td>
                    <td style={{ color: "var(--text-weak)", fontSize: 12 }}>{policyLabel(team.join_policy)}</td>
                    <td>
                      <Btn size="sm" disabled={busy} onClick={() => act(() => api.joinTeam(team.id), team.join_policy === "open" ? t("已加入团队", "Joined the team") : t("已提交申请", "Request submitted"))}>{t("申请", "Request")}</Btn>
                    </td>
                  </tr>
                ))}
                {!discover.length && <tr><td colSpan={5} style={{ color: "var(--text-weak)", textAlign: "center", padding: 24 }}>{t("[*] 没有可加入的团队", "[*] No teams available to join")}</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <Btn size="sm" variant="ghost" onClick={() => setShowBrowse(false)}>{t("关闭", "Close")}</Btn>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal
          wide
          title={`${t("团队", "Team")}: ${detail.name}`}
          onClose={() => { setDetail(null); setConfirmDelete(false) }}
          headerAction={detail.is_leader ? (
            confirmDelete ? (
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
                <span style={{ color: "var(--text-weak)", fontSize: 13 }}>{t("解散团队？", "Disband the team?")}</span>
                <Btn size="sm" variant="danger" disabled={busy} onClick={() => act(() => api.deleteTeam(detail.id), t("团队已解散", "Team disbanded"), true)}>{t("确认", "Confirm")}</Btn>
                <Btn size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>{t("取消", "Cancel")}</Btn>
              </span>
            ) : (
              <Btn size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>{t("解散团队", "Disband team")}</Btn>
            )
          ) : undefined}
        >
          <dl className="dl">
            <dt>{t("队长", "Leader")}</dt><dd>{detail.leader.username}{detail.is_leader && t("（你）", " (you)")}</dd>
            <dt>{t("加入方式", "Join policy")}</dt><dd>{policyLabel(detail.join_policy)}</dd>
            <dt>{t("成员", "Members")}</dt><dd>{detail.member_count}</dd>
            <dt>{t("描述", "Description")}</dt><dd>{detail.description || "-"}</dd>
          </dl>

          {detail.is_leader && (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: "8px 0" }}>{t("邀请成员", "Invite members")}</h4>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="field" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder={t("输入用户名", "Enter username")} style={{ flex: 1 }} />
                <Btn size="sm" disabled={busy || !inviteName.trim()} onClick={async () => { const n = inviteName.trim(); await act(() => api.inviteMember(detail.id, n), t("邀请已发出", "Invitation sent")); setInviteName("") }}>{t("邀请", "Invite")}</Btn>
              </div>
            </div>
          )}

          <h4 style={{ margin: "16px 0 8px" }}>{t("成员", "Members")}</h4>
          <table className="grid">
            <thead><tr><th>{t("用户", "User")}</th><th style={{ width: 120 }}>{t("状态", "Status")}</th><th style={{ width: 220 }}>{t("操作", "Actions")}</th></tr></thead>
            <tbody>
              {detail.members.map((m) => (
                <tr key={m.user_id}>
                  <td>{m.username}{m.user_id === me?.id && t("（你）", " (you)")}</td>
                  <td style={{ color: "var(--text-weak)", fontSize: 12 }}>{memberLabel(m)}</td>
                  <td>
                    {m.status === "active" && detail.is_leader && m.user_id !== detail.leader.id && (
                      <>
                        <Btn size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.transferLeadership(detail.id, m.user_id), t("已移交队长", "Leadership transferred"))}>{t("移交队长", "Transfer leadership")}</Btn>{" "}
                        <Btn size="sm" variant="danger" disabled={busy} onClick={() => act(() => api.removeMember(detail.id, m.user_id), t("已移除成员", "Member removed"))}>{t("移除", "Remove")}</Btn>
                      </>
                    )}
                    {m.status === "pending" && m.kind === "request" && detail.is_leader && (
                      <>
                        <Btn size="sm" disabled={busy} onClick={() => act(() => api.decideMembership(detail.id, m.user_id, "accept"), t("已通过", "Approved"))}>{t("通过", "Approve")}</Btn>{" "}
                        <Btn size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.decideMembership(detail.id, m.user_id, "reject"), t("已拒绝", "Rejected"))}>{t("拒绝", "Reject")}</Btn>
                      </>
                    )}
                    {m.status === "pending" && m.kind === "invite" && m.user_id === me?.id && (
                      <>
                        <Btn size="sm" disabled={busy} onClick={() => act(() => api.decideMembership(detail.id, m.user_id, "accept"), t("已加入", "Joined"))}>{t("接受", "Accept")}</Btn>{" "}
                        <Btn size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.decideMembership(detail.id, m.user_id, "reject"), t("已拒绝", "Rejected"))}>{t("拒绝", "Reject")}</Btn>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 style={{ margin: "16px 0 8px" }}>{t("共享到本团队的工作区", "Workspaces shared to this team")}</h4>
          {detail.workspaces.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {detail.workspaces.map((w) => (
                <li key={w.workspace_id}>
                  {w.name}
                  <span style={{ color: "var(--text-weak)", fontSize: 12 }}>{t("（属主", " (owner")} {w.owner || t("未知", "unknown")}{t("）", ")")}</span>{" "}
                  <span style={{ color: "var(--text-weak)", fontSize: 12, fontFamily: "var(--font-mono)" }}>{w.workspace_id.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: "var(--text-weak)", fontSize: 13 }}>{t("暂无 — 到「工作区」页把工作区共享给本团队。",
              "None yet — go to the Workspaces page and share a workspace to this team.")}</p>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
            <div>
              {!detail.is_leader && (
                <Btn variant="ghost" disabled={busy} onClick={() => act(() => api.leaveTeam(detail.id), t("已退出团队", "Left the team"), true)}>{t("退出团队", "Leave team")}</Btn>
              )}
            </div>
            <div>
              <Btn onClick={() => { setDetail(null); setConfirmDelete(false) }}>{t("关闭", "Close")}</Btn>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

type TeamMemberInfoLike = { status: string; kind: string }

function WorkspacesPage({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
  const [list, setList] = useState<Workspace[]>([])
  const [detail, setDetail] = useState<Workspace | null>(null)
  const [delTarget, setDelTarget] = useState<Workspace | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")
  // 团队共享（调用权）
  const [shareTarget, setShareTarget] = useState<Workspace | null>(null)
  const [myTeams, setMyTeams] = useState<TeamSummary[]>([])
  const [shareTeamIds, setShareTeamIds] = useState<Set<string>>(new Set())
  const [sharing, setSharing] = useState(false)
  // 团队共享给我的工作区（只读）
  const [sharedList, setSharedList] = useState<SharedWorkspace[]>([])
  const [sharedDetail, setSharedDetail] = useState<SharedWorkspace | null>(null)
  const [sharedQuery, setSharedQuery] = useState("")

  const refresh = useCallback(async () => {
    try {
      const [mine, shared] = await Promise.all([api.workspaces(), api.sharedWorkspaces()])
      setList(mine)
      setSharedList(shared.workspaces)
    } catch (e: any) { toast(e.message) }
  }, [toast])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  const toggle = async (w: Workspace) => {
    try {
      if (w.status === "disabled") await api.enableWorkspace(w.id)
      else await api.disableWorkspace(w.id)
      toast(w.status === "disabled" ? t("已启用", "Enabled") : t("已禁用", "Disabled"))
      refresh()
    } catch (e: any) { toast(e.message) }
  }

  const del = async (w: Workspace) => {
    try {
      await api.deleteWorkspace(w.id)
      toast(t("已删除", "Deleted"))
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

  const openShare = async (w: Workspace) => {
    try {
      const [teamsResp, s] = await Promise.all([api.teams(), api.workspaceShares(w.id)])
      setMyTeams(teamsResp.teams)
      setShareTeamIds(new Set(s.teams.map((x) => x.team_id)))
      setShareTarget(w)
    } catch (e: any) { toast(e.message) }
  }

  const saveShare = async () => {
    if (!shareTarget) return
    setSharing(true)
    try {
      await api.setWorkspaceShares(shareTarget.id, Array.from(shareTeamIds))
      toast(t("共享设置已保存", "Sharing settings saved"))
      setShareTarget(null)
    } catch (e: any) { toast(e.message) } finally { setSharing(false) }
  }

  const q = query.trim().toLowerCase()
  // 规划器工作区排在最前（稳定排序：其余项保持接口返回的名称序）
  const ordered = [...list].sort(
    (a, b) => (a.role === "planner" ? 0 : 1) - (b.role === "planner" ? 0 : 1),
  )
  const filtered = q
    ? ordered.filter((w) => hit(w.id, q) || hit(w.name, q) || hit(w.path, q) || hit(w.purpose, q) || hit(w.capabilities, q) || hit(w.notes, q))
    : ordered

  const sq = sharedQuery.trim().toLowerCase()
  const sharedShown = sq
    ? sharedList.filter((w) =>
        hit(w.name, sq) || hit(w.owner?.username, sq) || hit(w.purpose, sq) ||
        hit(w.agent_type, sq) || w.teams.some((tn) => hit(tn, sq)))
    : sharedList

  return (
    <>
      <h1 className="page-title">{t("工作区", "Workspaces")}</h1>
      <p className="page-sub">{t("你的 agent 工作区及在线状态，每 10s 自动刷新；下方另列团队共享给你的工作区。",
        "Your agent workspaces and their online status, refreshed every 10s; workspaces shared to you by teams are listed below.")}</p>
      <h3 style={{ margin: "8px 0" }}>{t("我的工作区", "My workspaces")}</h3>
      <SearchBox value={query} onChange={setQuery} placeholder={t("搜索名称 / 路径 / 用途…", "Search name / path / purpose…")} />
      <table className="grid ws-grid">
        <thead>
          <tr>
            <th style={{ width: 60 }}></th>
            <th>{t("名称", "Name")}</th>
            <th>{t("状态", "Status")}</th>
            <th>{t("路径", "Path")}</th>
            <th style={{ width: 180 }}>{t("会话", "Session")}</th>
            <th style={{ width: 450 }}>{t("用途", "Purpose")}</th>
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
                {w.role === "planner" && <span className="role-badge" title={t("规划器工作区", "Planner workspace")}>{t("规划器", "planner")}</span>}
              </td>
              <td>
                <span
                  title={w.status === "offline" && w.last_heartbeat ? `${t("最后心跳", "Last heartbeat")}: ${fmtTime(w.last_heartbeat, "datetime")}` : undefined}
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
                    title={expanded.has(w.id) ? t("收起", "Collapse") : t("展开", "Expand")}
                    onClick={() => toggleExpand(w.id)}
                  >
                    <ChevronIcon up={expanded.has(w.id)} />
                  </span>
                </div>
              </td>
              <td>
                <Btn variant="icon" title={t("共享到团队", "Share to team")} onClick={() => openShare(w)}>
                  <ShareIcon />
                </Btn>
                {w.status !== "online" && (
                  <Btn variant="icon" title={t("删除", "Delete")} onClick={() => setDelTarget(w)}>
                    <TrashIcon />
                  </Btn>
                )}
              </td>
            </tr>
          ))}
          {!filtered.length && (
            <tr><td colSpan={7} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
              {q ? t(`[*] 没有匹配「${query.trim()}」的工作区`, `[*] No workspaces match "${query.trim()}"`) : t("[*] 暂无工作区 — 在目标机器执行接入页的安装命令", "[*] No workspaces yet — run the install command on the target machine")}
            </td></tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginTop: 28, marginBottom: 8 }}>{t("共享工作区", "Shared workspaces")}</h3>
      <p className="page-sub" style={{ marginTop: 0 }}>
        <L
          zh={<>团队共享给你的工作区：可被你的 agent 通过 a2a_call 调用（只拿最终答复），
            你看不到它的监控 / 产物 / 调用细节，也无法启用 / 禁用 / 删除。</>}
          en={<>Workspaces shared to you by teams: your agent can call them via a2a_call (getting only the final answer),
            but you can't see their monitoring / artifacts / call details, nor enable / disable / delete them.</>}
        />
      </p>
      {sharedList.length > 0 && (
        <SearchBox value={sharedQuery} onChange={setSharedQuery} placeholder={t("搜索名称 / 所有者 / 团队 / 用途…", "Search name / owner / team / purpose…")} />
      )}
      {sharedShown.length ? (
        <table className="grid ws-grid">
          <thead>
            <tr>
              <th>{t("名称", "Name")}</th>
              <th style={{ width: 80 }}>{t("状态", "Status")}</th>
              <th style={{ width: 150 }}>{t("所有者", "Owner")}</th>
              <th style={{ width: 180 }}>{t("共享团队", "Shared teams")}</th>
              <th>{t("用途", "Purpose")}</th>
            </tr>
          </thead>
          <tbody>
            {sharedShown.map((w) => (
              <tr key={w.id}>
                <td className="strong">
                  <AgentTypeIcon type={w.agent_type} />
                  <a className="link" onClick={() => setSharedDetail(w)}>{w.name}</a>
                  {w.role === "planner" && <span className="role-badge" title={t("规划器工作区", "Planner workspace")}>{t("规划器", "planner")}</span>}
                </td>
                <td>
                  <span title={w.status === "offline" && w.last_heartbeat ? `${t("最后心跳", "Last heartbeat")}: ${fmtTime(w.last_heartbeat, "datetime")}` : undefined}>
                    <StatusDot status={w.status} />
                  </span>
                </td>
                <td>{w.owner?.username ?? "-"}</td>
                <td style={{ fontSize: 12, color: "var(--text-weak)" }}>{w.teams.join(t("、", ", "))}</td>
                <td className="purpose-td">
                  <div className={`purpose-cell ${expanded.has(w.id) ? "open" : ""}`}>
                    <span className="purpose-text">{w.purpose}</span>
                    <span className="expander" title={expanded.has(w.id) ? t("收起", "Collapse") : t("展开", "Expand")} onClick={() => toggleExpand(w.id)}>
                      <ChevronIcon up={expanded.has(w.id)} />
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: "var(--text-weak)" }}>
          {sharedList.length
            ? t(`[*] 没有匹配「${sharedQuery.trim()}」的共享工作区`, `[*] No shared workspaces match "${sharedQuery.trim()}"`)
            : t("[*] 暂无共享工作区——加入团队后，队友共享的工作区会出现在这里。", "[*] No shared workspaces yet — once you join a team, workspaces shared by teammates will appear here.")}
        </p>
      )}

      {sharedDetail && (
        <Modal title={sharedDetail.name} onClose={() => setSharedDetail(null)}>
          <dl className="dl">
            <dt>{t("状态", "Status")}</dt><dd><StatusDot status={sharedDetail.status} /></dd>
            {sharedDetail.role === "planner" && <><dt>{t("角色", "Role")}</dt><dd><span className="role-badge">{t("规划器", "planner")}</span></dd></>}
            <dt>{t("所有者", "Owner")}</dt><dd>{sharedDetail.owner?.username ?? "-"}</dd>
            <dt>{t("共享团队", "Shared teams")}</dt><dd>{sharedDetail.teams.join(t("、", ", "))}</dd>
            <dt>agent</dt>
            <dd style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AgentTypeIcon type={sharedDetail.agent_type} />
              {sharedDetail.agent_type || t("未知", "unknown")}
            </dd>
            <dt>{t("用途", "Purpose")}</dt><dd>{sharedDetail.purpose || "-"}</dd>
            <dt>{t("能力", "Capabilities")}</dt><dd>{sharedDetail.capabilities || "-"}</dd>
            <dt>{t("最后心跳", "Last heartbeat")}</dt><dd>{fmtTime(sharedDetail.last_heartbeat, "datetime")}</dd>
          </dl>
          <p style={{ color: "var(--text-weak)", fontSize: 13, marginTop: 12 }}>
            {t("团队共享工作区：可 a2a_call 获取最终答复，看不到监控 / 产物 / 调用细节；不能启用 / 禁用 / 删除。",
              "Team-shared workspace: call it via a2a_call to get the final answer, but you can't see monitoring / artifacts / call details, nor enable / disable / delete it.")}
          </p>
        </Modal>
      )}

      {shareTarget && (
        <Modal title={t(`共享「${shareTarget.name}」到团队`, `Share "${shareTarget.name}" to teams`)} onClose={() => setShareTarget(null)}>
          <p style={{ margin: 0, color: "var(--text-weak)", fontSize: 13 }}>
            {t("共享后，所选团队的成员可对该工作区发起 a2a_call（只拿最终答复），但看不到监控 / 产物 / 调用细节。",
              "Once shared, members of the selected teams can a2a_call this workspace (getting only the final answer), but can't see monitoring / artifacts / call details.")}
          </p>
          {myTeams.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "14px 0" }}>
              {myTeams.map((team) => (
                <label key={team.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={shareTeamIds.has(team.id)}
                    onChange={(e) => {
                      setShareTeamIds((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(team.id)
                        else next.delete(team.id)
                        return next
                      })
                    }}
                  />
                  {team.name}
                  {team.is_leader && <span style={{ color: "var(--text-weak)", fontSize: 12 }}>{t("（队长）", " (leader)")}</span>}
                </label>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--text-weak)", fontSize: 13, margin: "14px 0" }}>
              {t("你还没有加入任何团队 — 先到「团队」页创建或加入。", "You haven't joined any team yet — create or join one on the Teams page first.")}
            </p>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Btn size="sm" variant="ghost" onClick={() => setShareTarget(null)}>{t("取消", "Cancel")}</Btn>
            <Btn size="sm" disabled={sharing || !myTeams.length} onClick={saveShare}>{t("保存", "Save")}</Btn>
          </div>
        </Modal>
      )}

      {delTarget && (
        <Modal title={t(`删除 ${delTarget.name}？`, `Delete ${delTarget.name}?`)} onClose={() => setDelTarget(null)}>
          <p style={{ margin: 0, color: "var(--text-weak)", fontSize: 14 }}>{t("删除后工作区将从列表移除，不可恢复。", "The workspace will be removed from the list and cannot be recovered.")}</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setDelTarget(null)}>{t("取消", "Cancel")}</Btn>
            <Btn size="sm" variant="danger" onClick={() => { del(delTarget); setDelTarget(null) }}>{t("确认删除", "Confirm delete")}</Btn>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal wide title={detail.name} onClose={() => setDetail(null)}>
          <dl className="dl">
            <dt>ID</dt>
            <dd style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-weak)", wordBreak: "break-all" }}>{detail.id}</dd>
            <dt>{t("状态", "Status")}</dt><dd><StatusDot status={detail.status} /></dd>
            <dt>{t("角色", "Role")}</dt><dd>{detail.role === "planner" ? <span className="role-badge">{t("规划器", "planner")}</span> : "agent"}</dd>
            <dt>{t("路径", "Path")}</dt><dd>{detail.path}</dd>
            <dt>agent</dt>
            <dd style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AgentTypeIcon type={detail.agent_type} />
              {detail.agent_type || t("未知", "unknown")}
            </dd>
            <dt>{t("用途", "Purpose")}</dt><dd>{detail.purpose || "-"}</dd>
            <dt>{t("能力", "Capabilities")}</dt><dd>{detail.capabilities || "-"}</dd>
            <dt>{t("备注", "Notes")}</dt><dd>{detail.notes || "-"}</dd>
            <dt>{t("所有者", "Owner")}</dt><dd>{detail.owner?.username ?? "-"}</dd>
            <dt>{t("当前会话", "Current session")}</dt><dd>{detail.session_title || "-"}</dd>
            <dt>{t("最后心跳", "Last heartbeat")}</dt>
            <dd>{fmtTime(detail.last_heartbeat, "datetime")}</dd>
          </dl>
        </Modal>
      )}
    </>
  )
}

// ---------------- 产物 ----------------

function ArtifactsPage({ toast }: { toast: (m: string) => void }) {
  const { t } = useI18n()
  const [list, setList] = useState<Artifact[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<Artifact | null>(null)

  const load = useCallback(() => {
    api.artifacts().then((rows) => { setList(rows); setLoaded(true) }).catch(() => setLoaded(true))
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  const togglePin = async (a: Artifact) => {
    setBusy(a.id)
    try {
      const updated = await api.pinArtifact(a.id, !a.pinned)
      setList((prev) => prev.map((x) => (x.id === a.id ? updated : x)))
      toast(a.pinned ? t("已取消固定，将随 7 天保留期自动清理", "Unpinned; it will be auto-cleaned after the 7-day retention") : t("已固定，不再自动清理", "Pinned; it will no longer be auto-cleaned"))
    } catch (e) {
      toast(e instanceof Error ? e.message : t("操作失败", "Operation failed"))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (a: Artifact) => {
    setBusy(a.id)
    try {
      await api.deleteArtifact(a.id)
      setList((prev) => prev.filter((x) => x.id !== a.id))
      toast(t("产物已删除", "Artifact deleted"))
    } catch (e) {
      toast(e instanceof Error ? e.message : t("删除失败", "Delete failed"))
    } finally {
      setBusy(null)
    }
  }

  const shown = list.filter((a) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return hit(a.name, q) || hit(a.note, q) || hit(a.mime, q)
  })

  return (
    <>
      <h1 className="page-title">{t("产物", "Artifacts")}</h1>
      <p className="page-sub">
        <L
          zh={<>agent 通过 MCP 上传的产出文件（默认保留 7 天，固定后不自动清理；上传后也会按简报规则推送到飞书/微信窗口）。
            产物归属上传时所在的工作区——该工作区被共享给团队后，团队成员也能在这里看到并下载（只读）。</>}
          en={<>Output files uploaded by agents over MCP (kept 7 days by default; pinned ones are not auto-cleaned; on upload they are also pushed to Feishu/WeChat windows per the brief rules).
            An artifact belongs to the workspace it was uploaded from — once that workspace is shared with a team, team members can also see and download it here (read-only).</>}
        />
      </p>
      <SearchBox value={query} onChange={setQuery} placeholder={t("搜索文件名 / 备注 / 类型…", "Search filename / note / type…")} />
      <table className="grid">
        <thead>
          <tr>
            <th>{t("文件", "File")}</th>
            <th style={{ width: 160 }}>{t("来源", "Source")}</th>
            <th style={{ width: 90 }}>{t("大小", "Size")}</th>
            <th style={{ width: 150 }}>{t("上传时间", "Uploaded")}</th>
            <th style={{ width: 130 }}>{t("保留", "Retention")}</th>
            <th style={{ width: 170 }}></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => (
            <tr key={a.id}>
              <td>
                <a className="link" href={a.download_url} download={a.name}>{a.name}</a>
                {a.note && <div style={{ fontSize: 12, color: "var(--text-weak)", marginTop: 2 }}>{a.note}</div>}
              </td>
              <td style={{ fontSize: 12, color: "var(--text-weak)" }}>
                {a.workspace_name || "-"}
                {a.shared && <div title={t("来自团队共享工作区", "From a team-shared workspace")}>{t("来自", "From")} {a.owner || t("队友", "teammate")}{t("（团队共享）", " (team-shared)")}</div>}
              </td>
              <td style={{ color: "var(--text-weak)", fontSize: 12 }}>{fmtSize(a.size)}</td>
              <td style={{ color: "var(--text-weak)", fontSize: 12 }}>{fmtTime(a.created_at, "datetime")}</td>
              <td>
                {a.pinned ? (
                  <span className="status-pill accepted" title={t("固定后不参与自动清理", "Pinned artifacts are not auto-cleaned")}>{t("已固定", "Pinned")}</span>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--text-weak)" }}>
                    {a.remain_days > 0 ? t(`${a.remain_days} 天后清理`, `cleaned in ${a.remain_days} day${a.remain_days > 1 ? "s" : ""}`) : t("即将清理", "about to be cleaned")}
                  </span>
                )}
              </td>
              <td>
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  {!a.shared && (
                    <Btn variant="icon" size="sm" title={a.pinned ? t("取消固定（恢复自动清理）", "Unpin (resume auto-cleanup)") : t("固定（不自动清理）", "Pin (no auto-cleanup)")}
                      disabled={busy === a.id} onClick={() => togglePin(a)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill={a.pinned ? "currentColor" : "none"}
                        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M12 17v5" />
                        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                      </svg>
                    </Btn>
                  )}
                  <a className="btn-icon" href={a.download_url} download={a.name} title={t("下载", "Download")}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <path d="M7 10l5 5 5-5" />
                      <path d="M12 15V3" />
                    </svg>
                  </a>
                  {!a.shared && (
                    <Btn variant="icon" size="sm" className="btn-danger-hover" title={t("删除该产物", "Delete this artifact")}
                      disabled={busy === a.id} onClick={() => setConfirmDel(a)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                        strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M3 6h18" />
                        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </Btn>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {loaded && !shown.length && (
            <tr><td colSpan={6} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
              {list.length ? t(`[*] 没有匹配「${query.trim()}」的产物`, `[*] No artifacts match "${query.trim()}"`) : t("[*] 暂无产物——让 agent 调用 artifact_upload 工具上传文件", "[*] No artifacts yet — have an agent call the artifact_upload tool to upload a file")}
            </td></tr>
          )}
        </tbody>
      </table>
      {confirmDel && (
        <Modal title={t("删除产物？", "Delete artifact?")} onClose={() => setConfirmDel(null)}>
          <p style={{ margin: "0 0 16px", fontSize: 14 }}>
            {t("将删除产物", "The artifact")} <b>{confirmDel.name}</b>{t("，该操作不可恢复。", " will be deleted; this cannot be undone.")}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="ghost" onClick={() => setConfirmDel(null)}>{t("取消", "Cancel")}</Btn>
            <Btn size="sm" variant="danger" onClick={() => { const target = confirmDel; setConfirmDel(null); if (target) remove(target) }}>{t("删除", "Delete")}</Btn>
          </div>
        </Modal>
      )}
    </>
  )
}

function fmtSize(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

// ---------------- 调用记录 ----------------

/** 发起方显示：渠道标注原样展示（nexus-web / nexus-feishu / ...），互调标 agent */
function callerLabel(r: { caller: { name: string; path: string } | null; external_url?: string | null }): string {
  const c = r.caller
  if (!c?.name) return "-"
  return c.name
}

/** 规划器（planner）控制页：仅列 role=planner 工作区，管理目标与任务树。
 *  快照经 GET /api/planner/{wid}/state 轮询（由 规划核心服务 从 /ws/planner 推回），
 *  操作（建/改/归档目标、审批、催促、验收）经 POST /api/planner/{wid}/op 下发。 */
function PlannerPage({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Workspace[]>([])
  const [selected, setSelected] = useState<string>(() => {
    // 记忆上次选中的规划器工作区（cookie，30 天；同中转/调用记录惯例）
    const m = document.cookie.match(/(?:^|;\s*)swarm_planner_ws=([^;]*)/)
    try { return m ? decodeURIComponent(m[1]) : "" } catch { return "" }
  })
  const [state, setState] = useState<PlannerState | null>(null)
  const [goalId, setGoalId] = useState<string>("")
  const [busy, setBusy] = useState(false)
  /** 安装规划核心服务：平台分发的一键安装命令（无规划器工作区时展示） */
  const [plat, setPlat] = useState<"sh" | "ps1">(/Win/i.test(navigator.platform) ? "ps1" : "sh")
  const [me, setMe] = useState<(User & { api_key: string }) | null>(null)
  useEffect(() => { api.me().then(setMe).catch(() => {}) }, [])
  const plannerCmd =
    plat === "sh"
      ? `curl -fsSL ${pageOrigin}/download/planner-install.sh | bash -s -- --api-key ${me?.api_key || "你的apikey"}`
      : `& ([scriptblock]::Create((irm ${pageOrigin}/download/planner-install.ps1))) -ApiKey ${me?.api_key || "你的apikey"}`
  /** 工作区列表是否已加载完毕（首帧不闪「安装」面板） */
  const [loaded, setLoaded] = useState(false)
  /** 待硬删除的目标（二次确认用） */
  const [delGoal, setDelGoal] = useState<PlannerGoal | null>(null)
  /** 任务详情弹窗 */
  const [taskDetail, setTaskDetail] = useState<PlannerTask | null>(null)
  /** 是否隐藏已归档目标（默认隐藏；cookie 记忆，30 天） */
  const [hideArchived, setHideArchived] = useState<boolean>(() => {
    const m = document.cookie.match(/(?:^|;\s*)swarm_planner_hide_archived=([^;]*)/)
    return m ? m[1] !== "0" : true
  })
  useEffect(() => {
    document.cookie = `swarm_planner_hide_archived=${hideArchived ? "1" : "0"}; max-age=${60 * 60 * 24 * 30}; path=/; SameSite=Lax`
  }, [hideArchived])
  /** 任务树里被折叠的节点 id 集合 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** 工作区 id → 名字（把任务的 assigned_agent 显示成名字而非 id） */
  const [wsName, setWsName] = useState<Record<string, string>>({})
  /** 专家工作区候选（自有 + 团队共享；建目标时可选，排除当前 planner 工作区自身） */
  const [expertOptions, setExpertOptions] = useState<
    Array<{ id: string; name: string; path: string; agent_type?: string | null; owner?: string | { username: string } | null }>
  >([])

  // 新建/编辑目标表单
  const [form, setForm] = useState<{ goal?: PlannerGoal } | null>(null)
  const [fTitle, setFTitle] = useState("")
  const [fDesc, setFDesc] = useState("")
  const [fPriority, setFPriority] = useState("")
  const [fDeadline, setFDeadline] = useState("")
  const [fCriteria, setFCriteria] = useState("")
  const [fExpert, setFExpert] = useState("")  // expert_workspace_id（空 = 无专家）
  // 需要备注的操作弹窗（plan.revise / task.reject）
  const [noteModal, setNoteModal] = useState<{ op: string; goalId?: string; taskId?: string; label: string } | null>(null)
  const [noteText, setNoteText] = useState("")

  const refreshList = useCallback(async () => {
    try {
      const [mine, shared] = await Promise.all([api.workspaces(), api.sharedWorkspaces()])
      setList(mine.filter((w) => w.role === "planner"))
      // 自有 + 团队共享工作区的 id → 名字（任务 assigned_agent 展示用）
      setWsName(Object.fromEntries([...mine, ...shared.workspaces].map((w) => [w.id, w.name])))
      // 专家工作区候选：自有（含路径）/ 团队共享（无路径，补空串以保证选择器字段完整）
      setExpertOptions([
        ...mine.map((w) => ({ id: w.id, name: w.name, path: w.path, agent_type: w.agent_type, owner: w.owner })),
        ...shared.workspaces.map((w) => ({ id: w.id, name: w.name, path: "", agent_type: w.agent_type, owner: w.owner })),
      ])
    } catch { /* 静默 */ }
    finally { setLoaded(true) }
  }, [])
  useEffect(() => {
    refreshList()
    const t = setInterval(refreshList, 15_000)
    return () => clearInterval(t)
  }, [refreshList])

  // 默认选中第一个规划器工作区
  useEffect(() => {
    if (!selected && list.length) setSelected(list[0].id)
  }, [list, selected])

  useEffect(() => {
    if (selected) {
      document.cookie = `swarm_planner_ws=${encodeURIComponent(selected)}; max-age=${60 * 60 * 24 * 30}; path=/; SameSite=Lax`
    }
  }, [selected])

  // 轮询 规划核心服务 推回的快照（状态 + 目标 + 任务树）
  const loadState = useCallback(() => {
    if (!selected) { setState(null); return }
    api.plannerState(selected).then(setState).catch(() => {})
  }, [selected])
  useEffect(() => {
    loadState()
    const t = setInterval(loadState, 2500)
    return () => clearInterval(t)
  }, [loadState])

  // 默认选中第一个「可见」目标（隐藏归档时归档目标不参与默认选中）
  useEffect(() => {
    if (!state) return
    const vis = hideArchived ? state.goals.filter((g) => g.status !== "archived") : state.goals
    if (vis.length && !vis.some((g) => g.id === goalId)) setGoalId(vis[0].id)
  }, [state, goalId, hideArchived])

  /** 下发操作：POST /api/planner/{wid}/op；成功后稍后刷新快照（回执经同一通道到达） */
  const runOp = async (op: string, payload: Record<string, unknown>, okMsg: string) => {
    if (!selected) return
    if (!online) { toast("规划核心服务未连接，无法下发操作"); return }
    setBusy(true)
    try {
      await api.plannerOp(selected, op, payload)
      toast(okMsg)
      setTimeout(loadState, 900)
    } catch (e) {
      toast(e instanceof Error ? e.message : "操作失败")
    } finally { setBusy(false) }
  }

  /** 优先级选择值归一：核心服务约定 高=2 / 中=1 / 低=0；未知值回退「中」 */
  const normPriority = (p?: number | string) => {
    const s = String(p ?? "")
    return s === "2" || s === "0" ? s : "1"
  }
  const openCreate = () => {
    setFTitle(""); setFDesc(""); setFPriority("1"); setFDeadline(""); setFCriteria(""); setFExpert("")
    setForm({})
  }
  const openEdit = (g: PlannerGoal) => {
    setFTitle(g.title || ""); setFDesc(g.description || ""); setFPriority(normPriority(g.priority))
    setFDeadline(g.deadline || ""); setFCriteria(g.success_criteria || "")
    setFExpert(g.expert_workspace_id || "")  // 编辑态也允许改专家
    setForm({ goal: g })
  }
  const submitForm = () => {
    if (!fTitle.trim()) { toast("请填写目标标题"); return }
    const payload: Record<string, unknown> = {
      title: fTitle.trim(), description: fDesc.trim(),
      priority: Number(fPriority),              // 高=2 / 中=1 / 低=0
      deadline: fDeadline.trim(),               // 空串 = 无截止
      success_criteria: fCriteria.trim(),
    }
    // 专家工作区：新建/编辑都可选；显式下发两个字段（空串 = 清除专家）
    payload.expert_workspace_id = fExpert
    payload.expert_name = fExpert ? (expertOptions.find((w) => w.id === fExpert)?.name || "") : ""
    if (form?.goal) {
      // 人工改了成功标准 → 该标准回到「待专家确认」（未改则不动 criteria_confirmed）
      if (fCriteria.trim() !== (form.goal.success_criteria || "")) payload.criteria_confirmed = 0
      runOp("goal.update", { goal_id: form.goal.id, ...payload }, "目标已更新")
    } else {
      runOp("goal.create", payload, "目标已创建")
    }
    setForm(null)
  }
  const submitNote = () => {
    if (!noteModal) return
    const payload: Record<string, unknown> = {}
    if (noteModal.goalId) payload.goal_id = noteModal.goalId
    if (noteModal.taskId) payload.task_id = noteModal.taskId
    if (noteModal.op === "plan.revise") payload.note = noteText.trim()
    if (noteModal.op === "task.reject") payload.reason = noteText.trim()
    runOp(noteModal.op, payload, "操作已下发")
    setNoteModal(null); setNoteText("")
  }

  const goals = state?.goals ?? []
  // 默认隐藏已归档目标（checkbox 控制）；归档目标取消勾选后才显示，可对其「激活」/「删除」
  const visibleGoals = hideArchived ? goals.filter((g) => g.status !== "archived") : goals
  const goal = visibleGoals.find((g) => g.id === goalId)
  const goalTasks = (state?.tasks ?? []).filter((t) => t.goal_id === goalId)
  // 任务 id → 标题（依赖列显示任务名字而非 id）
  const taskTitle: Record<string, string> = {}
  for (const t of state?.tasks ?? []) taskTitle[t.id] = t.title
  const online = !!state?.online
  /** 状态 → status-pill 类名（running/ready/pending 复用蓝色；待验收类用橙色） */
  const pill = (k?: string) => {
    if (k === "waiting_expert" || k === "waiting_human") return "status-pill pending"
    return `status-pill ${k === "running" || k === "ready" || k === "pending" ? "accepted" : (k || "")}`.trim()
  }
  /** 状态展示文案（waiting_expert 友好化为「待专家验收」） */
  const statusLabel = (k?: string) => (k === "waiting_expert" ? "待专家验收" : (k || "-"))
  /** 验收类型展示文案：auto→自动验收 / manual→人工验收 / expert→专家验收点 */
  const acceptanceLabel = (a?: string) =>
    a === "auto" ? "自动验收" : a === "manual" ? "人工验收" : a === "expert" ? "专家验收点" : (a || "-")
  /** 目标状态 → 中文（active=进行中 / archived=已归档；未知回退原文） */
  const goalStatusLabel = (s?: string) =>
    s === "active" ? "进行中" : s === "archived" ? "已归档" : (s || "-")
  /** 优先级数值 → 文案（高=2 / 中=1 / 低=0；未知回退原文） */
  const priorityLabel = (p?: number | string) => {
    const s = String(p ?? "")
    return s === "2" ? "高" : s === "1" ? "中" : s === "0" ? "低" : (s || "-")
  }
  /** 目标专家展示：优先核心服务推的 expert_name，回退工作区名/ id */
  const expertLabel = (g: PlannerGoal) =>
    g.expert_name || (g.expert_workspace_id ? (wsName[g.expert_workspace_id] || g.expert_workspace_id) : "")
  /** 工作区 id → 名字（无则回退 id / "-"） */
  const agentName = (id?: string) => (id ? (wsName[id] || id) : "-")

  // 任务树：父 = depends_on 里第一个存在的依赖；据此建 children，再按折叠状态展开成行（含深度）。
  // 防御环依赖：结构可达集合与渲染遍历分别用 seen/path 保护。
  const treeRows: { task: PlannerTask; depth: number; hasChildren: boolean }[] = []
  {
    const byId = new Map(goalTasks.map((t) => [t.id, t]))
    const children = new Map<string, PlannerTask[]>()
    const roots: PlannerTask[] = []
    for (const t of goalTasks) {
      const parent = (t.depends_on ?? []).find((d) => byId.has(d) && d !== t.id)
      if (parent) {
        if (!children.has(parent)) children.set(parent, [])
        children.get(parent)!.push(t)
      } else roots.push(t)
    }
    const reachable = new Set<string>()
    const markReach = (t: PlannerTask) => {
      if (reachable.has(t.id)) return
      reachable.add(t.id)
      for (const c of children.get(t.id) ?? []) markReach(c)
    }
    roots.forEach(markReach)
    const path = new Set<string>()
    const walk = (t: PlannerTask, depth: number) => {
      if (path.has(t.id)) return
      path.add(t.id)
      const kids = children.get(t.id) ?? []
      treeRows.push({ task: t, depth, hasChildren: kids.length > 0 })
      if (!collapsed.has(t.id)) for (const c of kids) walk(c, depth + 1)
      path.delete(t.id)
    }
    roots.forEach((r) => walk(r, 0))
    // 环依赖导致结构不可达的节点：作为根补上（只补一次）
    for (const t of goalTasks) {
      if (!reachable.has(t.id)) {
        path.clear()
        walk(t, 0)
        markReach(t)
      }
    }
  }

  const installPanel = (
    <div className="home-install" style={{ marginTop: 12 }}>
      <h2>马上安装规划器</h2>
      <div className="tablist tablist-inline">
        <button role="tab" aria-selected={plat === "sh"} onClick={() => setPlat("sh")}>macOS / linux</button>
        <button role="tab" aria-selected={plat === "ps1"} onClick={() => setPlat("ps1")}>windows</button>
      </div>
      <div className="cmdblock cmdblock-joined">
        <span className="cmd-text">
          <span className="prompt">{plat === "sh" ? "$" : "PS>"}</span>
          {me && !me.api_key ? "# 正在获取 api key…" : plannerCmd}
        </span>
        <Btn variant="icon" title="copy" onClick={async () => {
          toast(await copyText(plannerCmd) ? "安装命令已复制" : "复制失败，请手动选择复制")
        }}>⧉</Btn>
      </div>
    </div>
  )

  // 没有规划器工作区：整页只显示安装控件（不显示工作区选择器 / 目标区）
  if (loaded && !list.length) {
    return (
      <div>
        <h1 className="page-title">规划器</h1>
        <p className="page-sub">
          把模糊的长期目标交给规划器工作区，自动拆成带依赖的任务树、调度虫群执行并追踪验收。
          先安装<b>规划核心服务</b>，再在项目目录里用 <code>/swarm-add-planner</code> 注册。
        </p>
        {installPanel}
      </div>
    )
  }

  return (
    <div>
      <h1 className="page-title">规划器</h1>
      <p className="page-sub">
        管理<b>规划器工作区</b>的目标与任务树：新建 / 编辑目标、审批拆解、催促 agent、
        人工验收。数据由规划核心服务经控制通道推回，操作实时下发。
      </p>
      <div className="nexus-picker" style={{ marginBottom: 12 }}>
        <NexusWorkspaceSelect list={list} value={selected} onChange={setSelected} showOwner />
        {selected && (
          <span className={`nexus-head-status ${online ? "on" : "off"}`}
            title={online ? "规划核心服务已连接" : "规划核心服务未连接"}>
            {online ? "● online" : "○ offline"}
          </span>
        )}
      </div>

      {selected && !state?.updated_at && (
        <p style={{ color: "var(--text-weak)" }}>
          {online
            ? "规划核心服务已连接，等待首个状态快照…"
            : "规划核心服务未连接 — 启动它后这里会显示目标与任务树。"}
        </p>
      )}
      {selected && state?.updated_at && !online && (
        <p style={{ color: "var(--text-weak)" }}>
          规划核心服务未连接 — 以下是最近一次快照（{fmtTime(state.updated_at, "datetime")}），启动后会自动刷新。
        </p>
      )}

      {selected && state && (
        <>
          <h3 className="planner-h3" style={{ margin: "8px 0", justifyContent: "space-between" }}>
            <span className="planner-h3-title">
              <TrophyIcon />
              目标
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
              <label
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-weak)", cursor: "pointer", fontWeight: 400 }}
                title="默认不显示已归档目标；取消勾选可查看并激活/删除"
              >
                <input type="checkbox" checked={hideArchived} onChange={(e) => setHideArchived(e.target.checked)} />
                隐藏已归档目标
              </label>
              <ActionBtn icon={<PlusIcon />} onClick={openCreate} disabled={!online} title="新建目标">
                新建目标
              </ActionBtn>
            </span>
          </h3>
          <table className="grid">
            <thead>
              <tr>
                <th>标题</th>
                <th style={{ width: 170 }}>状态</th>
                <th style={{ width: 90 }}>优先级</th>
                <th style={{ width: 120 }}>截止</th>
                <th style={{ width: 70 }}>进度</th>
                <th style={{ width: 520 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleGoals.map((g) => (
                <tr key={g.id} className={g.id === goalId ? "planner-row-active" : ""}
                  onClick={() => setGoalId(g.id)}>
                  <td className="strong">
                    <a className="link">{g.title}</a>
                    {g.expert_workspace_id ? (
                      <div style={{ fontSize: 12, color: "var(--text-weak)" }} title={g.expert_workspace_id}>
                        专家：
                        {g.expert_workspace_id === selected ? (
                          <span className="status-pill pending" style={{ marginLeft: 2 }}>本工作区（自评审）</span>
                        ) : expertLabel(g)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <span
                        className={`status-pill ${g.status === "active" ? "active" : g.status === "archived" ? "archived" : (g.status || "")}`}
                        title="目标状态"
                      >
                        {goalStatusLabel(g.status)}
                      </span>
                      {(g.plan_status || "draft") === "approved" ? (
                        <span className="status-pill done" title="拆解已通过，agent 可开始派发">已通过</span>
                      ) : (
                        <span className="status-pill pending" title="拆解待审批，通过后 agent 才会派发">草稿</span>
                      )}
                      {g.criteria_confirmed === 1 ? (
                        <span className="status-pill done" title="成功标准已由专家确认">专家已确认</span>
                      ) : (
                        <span className="status-pill pending" title="成功标准待专家确认">待专家确认</span>
                      )}
                    </div>
                  </td>
                  <td>{priorityLabel(g.priority)}</td>
                  <td style={{ fontSize: 12, color: "var(--text-weak)" }}>{g.deadline || "无截止"}</td>
                  <td style={{ fontSize: 12 }}>{g.progress ? `${g.progress.done}/${g.progress.total}` : "-"}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "nowrap" }}>
                      <ActionBtn icon={<BoltIcon />} disabled={busy || !online} title="催促规划器 agent 决策"
                        onClick={() => runOp("goal.nudge", { goal_id: g.id }, "已催促规划器")}>催促</ActionBtn>
                      {(g.plan_status || "draft") === "draft" && (
                        <ActionBtn icon={<CheckIcon />} disabled={busy || !online} title="审批通过拆解，通知 agent 开始派发"
                          onClick={() => runOp("plan.approve", { goal_id: g.id }, "已通过拆解")}>通过拆解</ActionBtn>
                      )}
                      <ActionBtn icon={<RefreshIcon />} disabled={busy || !online} title="要求重新拆解"
                        onClick={() => { setNoteText(""); setNoteModal({ op: "plan.revise", goalId: g.id, label: "重新拆解" }) }}>重新拆解</ActionBtn>
                      <ActionBtn icon={<PencilIcon />} disabled={busy || !online} title="编辑目标"
                        onClick={() => openEdit(g)}>编辑</ActionBtn>
                      {g.status === "archived" ? (
                        <ActionBtn icon={<RefreshIcon />} disabled={busy || !online} title="恢复已归档目标为 active"
                          onClick={() => runOp("goal.activate", { goal_id: g.id }, "目标已激活")}>激活</ActionBtn>
                      ) : (
                        <ActionBtn icon={<ArchiveIcon />} disabled={busy || !online} title="归档：软隐藏，保留数据、不参与调度，可再「激活」恢复"
                          onClick={() => runOp("goal.archive", { goal_id: g.id }, "目标已归档")}>归档</ActionBtn>
                      )}
                      <ActionBtn icon={<TrashIcon size={14} />} danger disabled={busy || !online} title="删除目标：不可恢复，连同任务树/执行记录一起删除"
                        onClick={() => setDelGoal(g)}>删除</ActionBtn>
                    </div>
                  </td>
                </tr>
              ))}
              {!visibleGoals.length && (
                <tr><td colSpan={6} style={{ color: "var(--text-weak)", textAlign: "center", padding: 32 }}>
                  {goals.length && hideArchived
                    ? "[*] 目标都已归档 — 取消勾选「隐藏已归档目标」可查看 / 激活"
                    : "[*] 暂无目标 — 点「新建目标」"}
                </td></tr>
              )}
            </tbody>
          </table>

          {goal && (
            <>
              <h3 className="planner-h3" style={{ margin: "20px 0 8px" }}>
                <NotebookIcon />
                任务树：{goal.title}
              </h3>
              {(goal.plan_status || "draft") === "draft" && (
                <p style={{ color: "var(--text-weak)", fontSize: 13, margin: "0 0 8px" }}>
                  待审批：通过拆解后 agent 才会开始派发任务。
                </p>
              )}
              <table className="grid">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th style={{ width: 110 }}>状态</th>
                    <th style={{ width: 160 }}>依赖</th>
                    <th style={{ width: 140 }}>执行 agent</th>
                    <th style={{ width: 90 }}>验收</th>
                    <th style={{ width: 150 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {treeRows.map(({ task: t, depth, hasChildren }) => (
                    <tr key={t.id}>
                      <td>
                        <div style={{ paddingLeft: depth * 18, display: "flex", alignItems: "center", gap: 2 }}>
                          {hasChildren ? (
                            <button
                              className={`tree-toggle${collapsed.has(t.id) ? " collapsed" : ""}`}
                              title={collapsed.has(t.id) ? "展开子任务" : "折叠子任务"}
                              onClick={() => setCollapsed((prev) => {
                                const n = new Set(prev)
                                if (n.has(t.id)) n.delete(t.id); else n.add(t.id)
                                return n
                              })}
                            >
                              <ChevronIcon size={16} />
                            </button>
                          ) : <span className="tree-toggle-placeholder" />}
                          <a className="link" title="查看任务详情" onClick={() => setTaskDetail(t)}>{t.title}</a>
                        </div>
                      </td>
                      <td><span className={pill(t.status)}>{statusLabel(t.status)}</span></td>
                      <td style={{ fontSize: 12, color: "var(--text-weak)" }}>
                        {(t.depends_on ?? []).map((d) => taskTitle[d] || d).join("、") || "-"}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-weak)" }} title={t.assigned_agent || undefined}>
                        {t.assigned_agent ? (wsName[t.assigned_agent] || t.assigned_agent) : "-"}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-weak)" }}>
                        {t.acceptance_type === "expert" ? (
                          <span className="status-pill accepted" title="专家验收点：由 planner agent 汇总情况请专家裁决，平台不介入">专家验收点</span>
                        ) : (t.acceptance_type ? acceptanceLabel(t.acceptance_type) : "-")}
                      </td>
                      <td>
                        {t.acceptance_type === "manual" && t.status !== "done" ? (
                          <div style={{ display: "flex", gap: 4 }}>
                            <ActionBtn icon={<CheckIcon />} disabled={busy || !online} title="人工验收通过"
                              onClick={() => runOp("task.accept", { task_id: t.id }, "已验收通过")}>通过</ActionBtn>
                            <ActionBtn icon={<XIcon />} danger disabled={busy || !online} title="人工验收拒绝"
                              onClick={() => { setNoteText(""); setNoteModal({ op: "task.reject", taskId: t.id, label: "验收拒绝" }) }}>拒绝</ActionBtn>
                          </div>
                        ) : <span style={{ color: "var(--text-weak)", fontSize: 12 }}>—</span>}
                      </td>
                    </tr>
                  ))}
                  {!goalTasks.length && (
                    <tr><td colSpan={6} style={{ color: "var(--text-weak)", textAlign: "center", padding: 24 }}>[*] 该目标暂无任务</td></tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {form && (
        <Modal wide title={form.goal ? "编辑目标" : "新建目标"} onClose={() => setForm(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              标题 *
              <input className="field" value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="例如：重构鉴权模块" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              描述
              <textarea className="field" rows={3} value={fDesc} onChange={(e) => setFDesc(e.target.value)} />
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                优先级
                <select className="field" value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
                  <option value="2">高</option>
                  <option value="1">中</option>
                  <option value="0">低</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                截止（可选）
                <input className="field" value={fDeadline} onChange={(e) => setFDeadline(e.target.value)} placeholder="不填则无截止" />
              </label>
            </div>
            {form.goal ? (
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                成功标准
                <textarea className="field" rows={2} value={fCriteria} onChange={(e) => setFCriteria(e.target.value)} />
                <span style={{ fontSize: 12, color: "var(--text-weak)" }}>
                  成功标准由专家确认；此处人工修改后徽标会回到「待专家确认」。
                </span>
              </label>
            ) : null}
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              专家工作区（可选）
              <NexusWorkspaceSelect
                list={expertOptions}
                value={fExpert}
                onChange={setFExpert}
                showOwner
              />
              <span style={{ fontSize: 12, color: "var(--text-weak)" }}>
                {fExpert && fExpert === selected
                  ? "专家 = 当前 planner 工作区自身 → 自评审：planner agent 自行拆解，不走 A2A。"
                  : "指定后由该专家拆解任务树并设专家验收点；留空 = 无专家（编辑时清空可移除专家）。"}
              </span>
            </label>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setForm(null)}>取消</Btn>
            <Btn size="sm" disabled={busy || !online} onClick={submitForm}>{form.goal ? "保存" : "创建"}</Btn>
          </div>
        </Modal>
      )}

      {noteModal && (
        <Modal title={noteModal.label} onClose={() => setNoteModal(null)}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {noteModal.op === "plan.revise" ? "重新拆解说明（可选）" : "拒绝原因（可选）"}
            <textarea className="field" rows={3} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setNoteModal(null)}>取消</Btn>
            <Btn size="sm" variant={noteModal.op === "task.reject" ? "danger" : "primary"} disabled={busy || !online} onClick={submitNote}>确认</Btn>
          </div>
        </Modal>
      )}

      {delGoal && (
        <Modal title={`删除目标「${delGoal.title}」？`} onClose={() => setDelGoal(null)}>
          <p style={{ margin: 0, color: "var(--text-weak)", fontSize: 14 }}>
            删除<b style={{ color: "#d1242f" }}>不可恢复</b>，将连同该目标的<b>任务树 / 执行记录</b>一起删除。
            若只是想隐藏、保留数据，请改用「归档」（可随时用「激活」恢复）。
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setDelGoal(null)}>取消</Btn>
            <Btn
              size="sm"
              variant="danger"
              disabled={busy || !online}
              onClick={() => {
                runOp("goal.delete", { goal_id: delGoal.id }, "目标已删除")
                setGoalId("")  // 清空选中；刷新后自动落到剩余第一个目标
                setDelGoal(null)
              }}
            >
              确认删除
            </Btn>
          </div>
        </Modal>
      )}

      {taskDetail && (
        <Modal wide title={`任务：${taskDetail.title}`} onClose={() => setTaskDetail(null)}>
          <dl className="dl">
            <dt>状态</dt>
            <dd><span className={pill(taskDetail.status)}>{statusLabel(taskDetail.status)}</span></dd>
            <dt>所属目标</dt>
            <dd>{goals.find((g) => g.id === taskDetail.goal_id)?.title || taskDetail.goal_id || "-"}</dd>
            <dt>描述</dt><dd>{taskDetail.description || "-"}</dd>
            <dt>依赖</dt>
            <dd>{(taskDetail.depends_on ?? []).map((d) => taskTitle[d] || d).join("、") || "-"}</dd>
            <dt>建议执行 agent</dt><dd title={taskDetail.suggested_agent || undefined}>{agentName(taskDetail.suggested_agent)}</dd>
            {/* 核心服务暂无「实际执行 agent」独立字段（只有 assigned_agent 建议值）；留位显示 -，待其补字段后再填 */}
            <dt>实际执行 agent</dt><dd>-</dd>
            <dt>验收类型</dt><dd>{acceptanceLabel(taskDetail.acceptance_type)}</dd>
            <dt>验收结果</dt><dd>{taskDetail.acceptance_result || "-"}</dd>
            <dt>更新时间</dt><dd>{fmtTime(taskDetail.updated_at, "datetime")}</dd>
          </dl>
        </Modal>
      )}
    </div>
  )
}

function CallsPage({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<WorkspaceCall[]>([])
  const [detail, setDetail] = useState<WorkspaceCall | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [aborting, setAborting] = useState<string | null>(null)
  const [abortTarget, setAbortTarget] = useState<WorkspaceCall | null>(null)
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

  // 进行中：可中断（abort）；与状态标签 accepted 的判定保持一致
  const isActiveCall = (s: string) => s === "queued" || s === "working" || s === "input-required"
  const abortCall = async (call: WorkspaceCall) => {
    setAborting(call.id)
    try {
      const res = await api.cancelTask(wsFilter, call.id)
      if (res.ok) {
        toast("已发送中断请求")
        setList((prev) => prev.map((c) => (c.id === call.id ? { ...c, status: "canceled" } : c)))
        setDetail((d) => (d && d.id === call.id ? { ...d, status: "canceled" } : d))
      } else {
        toast(res.error || "任务已结束，无法中断")
      }
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : "中断失败")
    } finally {
      setAborting(null)
      setAbortTarget(null)
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
        <ActionBtn
          icon={<TrashIcon size={12} />}
          title="清空该工作区的全部调用记录"
          disabled={!wsFilter || clearingAll}
          onClick={() => setConfirmClear(true)}
        >
          clear
        </ActionBtn>
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
                    {isActiveCall(r.status) ? (
                      <Btn
                        variant="icon"
                        size="sm"
                        className="btn-danger-hover"
                        title="中断任务（abort）"
                        disabled={aborting === r.id}
                        onClick={() => setAbortTarget(r)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <rect x="6" y="6" width="12" height="12" rx="1.5" />
                        </svg>
                      </Btn>
                    ) : (
                      (r.status === "completed" || r.status === "failed" || r.status === "canceled") && (
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
                      )
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
          {isActiveCall(detail.status) && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <Btn size="sm" variant="danger" disabled={aborting === detail.id}
                onClick={() => setAbortTarget(detail)}>中断任务</Btn>
            </div>
          )}
        </Modal>
      )}

      {abortTarget && (
        <Modal title="中断任务" onClose={() => setAbortTarget(null)}>
          <p>确认中断任务 <code>{abortTarget.id.slice(0, 8)}</code>？</p>
          <p style={{ color: "var(--text-weak)", fontSize: 12 }}>
            中断会通知插件停止执行（后台任务 kill 进程树、前台会话 interrupt），任务置为 canceled；
            不可恢复，如需继续请重新派发。
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Btn size="sm" variant="ghost" onClick={() => setAbortTarget(null)}>取消</Btn>
            <Btn size="sm" variant="danger" disabled={!!aborting} onClick={() => abortCall(abortTarget)}>确认中断</Btn>
          </div>
        </Modal>
      )}
    </>
  )
}

// PasswordPage 已并入账号页的 PasswordForm（API Key / 修改密码 双 tab）

