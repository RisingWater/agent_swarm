/** opencode Desktop 心跳门控（2026-10-10）。
 *
 * 背景：V2 在线判定 = 开着 TUI（CLI 插件心跳）。但 opencode Desktop（Electron 版）
 * 没有 TUI 进程，CLI 插件不会跑 → Desktop 用户的项目永远离线、不可派发。
 *
 * 实锤的数据源（Windows 实机验证）：Desktop 把左侧「当前打开的项目列表」持久化在
 *   %APPDATA%/ai.opencode.desktop/drafts.sqlite
 *   → 表 state → name='opencode.global.dat'，key='server'
 *   → value JSON: { projects: { local: [{ worktree: "C:\\...", ... }] },
 *                   recentlyClosed: { local: ["C:\\...", ...] } }
 * projects.local = UI 左侧列表（开着的项目）；recentlyClosed = 刚关掉的。
 * 在 Desktop 里关掉项目会实时挪到 recentlyClosed（实测随操作落盘）。
 *
 * 本模块读它判断「本目录是否在 Desktop 打开列表里」：
 *   - 是 → server 插件可以代为心跳（在线、可派发，不依赖 TUI）
 *   - 否 → 不跳（维持 09-23 决策：没开 TUI 的项目不在线）
 *
 * 实现要点（零运行时依赖）：
 *   - 用 Node 22.5+ 内置的 node:sqlite（DatabaseSync）只读打开。Desktop 运行中文件
 *     可能被锁或处于 WAL 中间态——查询失败一律返回「不在列表」（宁可漏跳不误跳）。
 *   - 路径匹配统一为小写正斜杠（Windows 大小写不敏感；盘符/分隔符差异忽略）。
 *   - drafts.sqlite 不存在（CLI-only 机器）→ 返回 false，行为与现状一致。
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

/** 本目录是否在 Desktop「当前打开项目」列表里。任何异常都视为否（宁可漏跳不误跳）。 */
export function desktopHasProject(directory: string): boolean {
  try {
    if (!existsSync(DRAFTS_DB)) return false
    // node:sqlite 是 Node 22.5+ 内置模块（实验性）：动态 import，失败视为不在列表。
    // 只读打开 + readonly，Desktop 持有写锁时读一般仍可行；真锁死就下一轮再试。
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(DRAFTS_DB, { readOnly: true })
    try {
      const row = db
        .prepare(
          "SELECT value FROM state WHERE name = 'opencode.global.dat' AND key = 'server'",
        )
        .get()
      if (!row?.value) return false
      const parsed = JSON.parse(String(row.value))
      const local = parsed?.projects?.local
      if (!Array.isArray(local)) return false
      const target = normPath(directory)
      if (!target) return false
      return local.some((p: any) => normPath(p?.worktree ?? p) === target)
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}
