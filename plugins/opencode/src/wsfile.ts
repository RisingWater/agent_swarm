/** .agent_swarm/ 目录读写：工作区 ID 持久化（workspace.md）。
 *
 * 所有本地状态收进项目根 .agent_swarm/ 目录（对齐 .opencode/.claude 惯例）：
 *   workspace.md  — PURPOSE/CAPABILITIES/WORKSPACE_ID 三行
 *   sessions.json — 后台会话映射表（见 sessions.ts）
 * 目录应加入 .gitignore（机器本地状态，跨机器 ID 不通用）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const DIR = ".agent_swarm"
const WORKSPACE_FILE = "workspace.md"

function workspaceFile(dir: string): string {
  return join(dir, DIR, WORKSPACE_FILE)
}

/** 读 WORKSPACE_ID: 行（workspace_add 后由 agent 写入） */
export function readWorkspaceId(dir: string): string {
  const file = workspaceFile(dir)
  if (!existsSync(file)) return ""
  try {
    const text = readFileSync(file, "utf-8")
    return text.match(/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*([A-Za-z0-9_-]+)/im)?.[1] ?? ""
  } catch {
    return ""
  }
}

/** 写/更新 WORKSPACE_ID: 行；文件不存在则创建（含 PURPOSE/CAPABILITIES 占位） */
export function writeWorkspaceId(dir: string, id: string): void {
  const d = join(dir, DIR)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  const file = join(d, WORKSPACE_FILE)
  const line = `WORKSPACE_ID: ${id}`
  if (!existsSync(file)) {
    writeFileSync(
      file,
      `# agent_swarm\n\nPURPOSE: \nCAPABILITIES: \n${line}\n`,
      "utf-8",
    )
    return
  }
  const text = readFileSync(file, "utf-8")
  if (/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+/im.test(text)) {
    writeFileSync(file, text.replace(/^\s*(?:#+\s*)?WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+.*$/im, line), "utf-8")
  } else {
    writeFileSync(file, `${text.replace(/\s*$/, "")}\n${line}\n`, "utf-8")
  }
}

/** 工作区信息文件路径（/swarm-add 等命令/文档提示用） */
export function workspaceFilePath(dir: string): string {
  return join(dir, DIR, WORKSPACE_FILE)
}
