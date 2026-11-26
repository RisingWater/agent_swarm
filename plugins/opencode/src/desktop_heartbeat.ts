/** opencode Desktop 心跳门控（2026-10-10，2026-11-26 适配新版 schema）。
 *
 * 背景：V2 在线判定 = 开着 TUI（CLI 插件心跳）。但 opencode Desktop（Electron 版）
 * 没有 TUI 进程，CLI 插件不会跑 → Desktop 用户的项目永远离线、不可派发。
 *
 * 「本目录是否在 Desktop 里打开着」的数据源（drafts.sqlite，实测两代 schema）：
 *
 * 旧版（≤2.x 早期）：
 *   表 state → name='opencode.global.dat'，key='server'
 *   → value JSON: { projects: { local: [{ worktree: "C:\\...", ... }] },
 *                   recentlyClosed: { local: ["C:\\...", ...] } }
 *   projects.local = UI 左侧列表（开着的项目）；在 Desktop 里关掉项目会实时挪到
 *   recentlyClosed（实测随操作落盘）。
 *
 * 新版（2026-11 实测，Desktop 2.4.x）：projects.local 字段已消失（server 变成
 *   {"list":[],"usedProjectIDs":...}，只剩历史 ID 没有路径），「当前打开」改由
 *   窗口级持久化承载：
 *   表 state → name='opencode.window.<windowId>.dat'：
 *     key='tabs'      → [{ type:"session", sessionId:"ses_..." }, ...]（打开的标签页）
 *     key='tabs.info' → { "<sessionId>": { title, directory: "C:\\...", ... } }
 *   关掉标签页会实时挪到 tabs.closed（不再出现在 tabs 里）。
 *
 * 判定规则（新旧 schema 都支持）：
 *   - 旧 schema：目录在 projects.local 里 → 打开
 *   - 新 schema：存在任一窗口的**活动标签页**，其 tabs.info[sessionId].directory
 *     归一化后等于本目录 → 打开（关掉标签页 → 停跳 → 90s 自然离线，语义与旧版一致）
 *
 * 实现要点（零运行时依赖）：
 *   - 用 Node 22.5+ 内置的 node:sqlite（DatabaseSync）只读打开。Desktop 运行中文件
 *     可能被锁或处于 WAL 中间态——查询失败一律返回「不在列表」（宁可漏跳不误跳）。
 *   - 路径匹配统一为小写正斜杠（Windows 大小写不敏感；盘符/分隔符差异忽略）。
 *   - drafts.sqlite 不存在（CLI-only 机器）→ 返回 false，行为与现状一致。
 *   - 已知取舍：Desktop 进程被强杀时窗口 rows 不会清理，可能短暂误判「打开」；
 *     旧 schema 的 projects.local 同样有此问题（强杀不落 recentlyClosed），可接受。
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DRAFTS_DB = join(
  homedir(),
  "AppData",
  "Roaming",
  "ai.opencode.desktop",
  "drafts.sqlite",
)

/** 路径归一化：小写 + 正斜杠 + 去尾部分隔符（Windows 比较用） */
function normPath(p: string): string {
  return String(p ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** 旧 schema：opencode.global.dat/server 的 projects.local 路径列表（可能不存在） */
function legacyProjectDirs(db: any): string[] {
  const row = db
    .prepare(
      "SELECT value FROM state WHERE name = 'opencode.global.dat' AND key = 'server'",
    )
    .get()
  if (!row?.value) return []
  const parsed = JSON.parse(String(row.value))
  const local = parsed?.projects?.local
  if (!Array.isArray(local)) return []
  return local.map((p: any) => normPath(p?.worktree ?? p)).filter(Boolean)
}

/** 新 schema：所有窗口的活动标签页目录（tabs × tabs.info 按 sessionId 连接）
 *
 * 实测 key 形状：tabs[] 元素是 { type:"session", server:"sidecar", sessionId:"ses_..." }
 * （裸 sessionId）；tabs.info 的 key 是复合键
 * "sidecar\n/server/<base64>/session/<sessionId>"（server 名 + base64 编码 + 路径），
 * 两者按「key 以 session/<sessionId> 结尾」连接。
 */
function windowTabDirs(db: any): string[] {
  const rows = db
    .prepare(
      "SELECT name, key, value FROM state WHERE key IN ('tabs', 'tabs.info')",
    )
    .all()
  /** windowId → 该窗口的 tabs / tabs.info（info 按 sessionId 建索引） */
  const byWindow = new Map<
    string,
    { tabs?: any[]; infoBySession?: Map<string, any> }
  >()
  for (const r of rows) {
    const win = byWindow.get(String(r.name)) ?? {}
    try {
      const parsed = JSON.parse(String(r.value))
      if (r.key === "tabs") {
        win.tabs = Array.isArray(parsed) ? parsed : []
      } else {
        const idx = new Map<string, any>()
        if (parsed && typeof parsed === "object") {
          for (const [key, val] of Object.entries(parsed)) {
            const m = String(key).match(/session\/([^/]+)$/)
            if (m) idx.set(m[1], val)
          }
        }
        win.infoBySession = idx
      }
    } catch {
      continue
    }
    byWindow.set(String(r.name), win)
  }
  const dirs: string[] = []
  for (const win of byWindow.values()) {
    if (!Array.isArray(win.tabs) || !win.infoBySession) continue
    for (const tab of win.tabs) {
      const sid = String(tab?.sessionId ?? "")
      if (!sid) continue
      const dir = win.infoBySession.get(sid)?.directory
      if (dir) dirs.push(normPath(dir))
    }
  }
  return dirs
}

/** 本目录是否在 Desktop「当前打开项目」列表里。任何异常都视为否（宁可漏跳不误跳）。 */
export function desktopHasProject(directory: string): boolean {
  try {
    if (!existsSync(DRAFTS_DB)) return false
    // node:sqlite 是 Node 22.5+ 内置模块（实验性）：动态 import，失败视为不在列表。
    // 只读打开 + readonly，Desktop 持有写锁时读一般仍可行；真锁死就下一轮再试。
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(DRAFTS_DB, { readOnly: true })
    try {
      const target = normPath(directory)
      if (!target) return false
      const open = [...legacyProjectDirs(db), ...windowTabDirs(db)]
      return open.includes(target)
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}
