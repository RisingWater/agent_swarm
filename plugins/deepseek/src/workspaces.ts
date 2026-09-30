/** 全局工作区清单：~/.config/dsh/agent-swarm-workspaces.json
 * dsh 宿主是 profile 级单实例（cwd = profile 目录，不是用户项目），插件无法从
 * cwd 推断工作区——/swarm-add 时把 {wid, dir} 记入清单，心跳循环逐个上报。 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface WorkspaceEntry {
  workspaceId: string
  /** 项目目录（绝对路径） */
  directory: string
}

export function workspacesListPath(): string {
  return join(homedir(), ".config", "dsh", "agent-swarm-workspaces.json")
}

export function readWorkspaceList(): WorkspaceEntry[] {
  const file = workspacesListPath()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e: any) => e && typeof e.workspaceId === "string" && typeof e.directory === "string")
  } catch {
    return []
  }
}

export function writeWorkspaceList(entries: WorkspaceEntry[]): void {
  const file = workspacesListPath()
  try {
    writeFileSync(file, JSON.stringify(entries, null, 2) + "\n", "utf-8")
  } catch { /* 写失败下轮重试 */ }
}

/** 记入/更新清单（按 directory 去重）；removeId 传 id 时改为移除该条 */
export function updateWorkspaceList(entry: { workspaceId: string; directory: string }, removeId?: string): void {
  let list = readWorkspaceList()
  if (removeId) {
    list = list.filter((e) => e.workspaceId !== removeId)
  } else {
    list = list.filter((e) => e.directory !== entry.directory)
    if (entry.workspaceId) list.push(entry)
  }
  writeWorkspaceList(list)
}
