/** 后台会话映射表：来源（caller）⇒ opencode 会话 ID。
 *
 * 同一来源的 A2A 任务汇总到同一个后台会话（保证对话连续性，与前台 TUI 会话隔离）。
 * 存储为 .agent_swarm/sessions.json（机器本地状态，不进 git），内容形如：
 *   { "nexus-web": "ses_abc...", "ws_XXXX": "ses_def..." }
 * 键 = 任务 caller（nexus-web / 调用方工作区 ID / 外部 A2A 端点 URL）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const DIR = ".agent_swarm"
const SESSIONS_FILE = "sessions.json"

export function sessionsFilePath(dir: string): string {
  return join(dir, DIR, SESSIONS_FILE)
}

function writeSessionsFile(dir: string, data: string): void {
  const d = join(dir, DIR)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  writeFileSync(join(d, SESSIONS_FILE), data, "utf-8")
}

/** 读映射表（文件缺失/损坏返回空表） */
export function readSessionMap(dir: string): Record<string, string> {
  const file = sessionsFilePath(dir)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && k && typeof v === "string" && v) out[k] = v
    }
    return out
  } catch {
    return {} // 损坏时视为空表，下次写入重建
  }
}

/** 写/更新单条映射（caller → sessionId），文件不存在则创建 */
export function writeSessionEntry(dir: string, caller: string, sessionId: string): void {
  if (!caller || !sessionId) return
  const map = readSessionMap(dir)
  if (map[caller] === sessionId) return
  map[caller] = sessionId
  try {
    writeSessionsFile(dir, JSON.stringify(map, null, 2) + "\n")
  } catch {
    // 写失败不阻塞任务执行（下轮任务会再试）
  }
}
