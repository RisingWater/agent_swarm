/** .agent-swarm.md 读写：工作区 ID 持久化 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 读 WORKSPACE_ID: 行（workspace_add 后由 agent 写入） */
export function readWorkspaceId(dir: string): string {
  const file = join(dir, ".agent-swarm.md")
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
  const file = join(dir, ".agent-swarm.md")
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
