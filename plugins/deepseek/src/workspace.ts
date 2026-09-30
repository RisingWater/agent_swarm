/** 项目根 .agent_swarm/ 读写：WORKSPACE_ID（workspace.md）与 per-caller 会话映射（sessions.json）。
 * 与 opencode / claude 插件同一文件格式，三个 harness 可共用同一个工作区目录。 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const DIR = ".agent_swarm"

function workspaceFile(dir: string): string {
  return join(dir, DIR, "workspace.md")
}

/** 读 WORKSPACE_ID: 行（workspace_add 后由安装脚本/agent 写入） */
export function readWorkspaceId(dir: string): string {
  const file = workspaceFile(dir)
  if (!existsSync(file)) return ""
  try {
    return readFileSync(file, "utf-8")
      .match(/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*([A-Za-z0-9_-]+)/im)?.[1] ?? ""
  } catch {
    return ""
  }
}

export function workspaceFilePath(dir: string): string {
  return workspaceFile(dir)
}

/** 写/更新 WORKSPACE_ID 行；id 为空串 = 删除该行（注销用） */
export function writeWorkspaceId(dir: string, id: string): void {
  const d = join(dir, DIR)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  const file = workspaceFile(dir)
  if (!id) {
    if (!existsSync(file)) return
    const text = readFileSync(file, "utf-8")
    writeFileSync(file, text.replace(/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+.*\n?/im, ""), "utf-8")
    return
  }
  const line = `WORKSPACE_ID: ${id}`
  if (!existsSync(file)) {
    writeFileSync(file, `# agent_swarm\n\nPURPOSE: \nCAPABILITIES: \n${line}\n`, "utf-8")
    return
  }
  const text = readFileSync(file, "utf-8")
  if (/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+/im.test(text)) {
    writeFileSync(file, text.replace(/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+.*$/im, line), "utf-8")
  } else {
    writeFileSync(file, `${text.replace(/\s*$/, "")}\n${line}\n`, "utf-8")
  }
}

// ---------------- per-caller 会话映射表 ----------------

function sessionsFilePath(dir: string): string {
  return join(dir, DIR, "sessions.json")
}

function writeSessionsFile(dir: string, data: string): void {
  const d = join(dir, DIR)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  writeFileSync(join(d, SESSIONS_FILE), data, "utf-8")
}

const SESSIONS_FILE = "sessions.json"

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
