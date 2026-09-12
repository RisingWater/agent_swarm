/** agent_swarm opencode 插件：只负责心跳保活。
 *
 * 面向 agent 的操作（添加/移除/启用/禁用工作区等）全部走服务端 MCP
 * 工具（opencode.jsonc 里的 mcp.agent-swarm 配置），插件不再注入任何工具。
 * 工作区 ID 从项目根目录 .agent-swarm.md 的 WORKSPACE_ID: 行读取
 * （workspace_add 后由 agent 写入）；文件里没有就不心跳。
 *
 * 日志不进控制台（避免干扰 TUI），追加写到
 * ~/.config/opencode/plugins/agent-swarm/plugin.log（>1MB 截断一半）。
 */

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readWorkspaceId } from "./wsfile"
import { SwarmClient } from "./client"
import { loadConfig } from "./config"

const LOG_FILE = join(homedir(), ".config", "opencode", "plugins", "agent-swarm", "plugin.log")
const LOG_MAX_BYTES = 1_000_000

function log(msg: string) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      // 截断保留后半段，避免无限增长
      const text = readFileSync(LOG_FILE, "utf-8")
      truncateSync(LOG_FILE, 0)
      appendFileSync(LOG_FILE, text.slice(text.length - LOG_MAX_BYTES / 2))
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // 日志失败不影响主流程
  }
}

const plugin: Plugin = async (input) => {
  const { directory } = input
  const cfg = loadConfig()
  if (!cfg) {
    log("no apiKey config; plugin disabled")
    return {}
  }
  const heartbeatMs = cfg.heartbeatIntervalMs ?? 30_000
  const swarm = new SwarmClient(cfg)

  let currentSessionId = ""
  let disposed = false

  async function heartbeatLoop() {
    let workspaceId = readWorkspaceId(directory)
    log(`start: directory=${directory} workspaceId=${workspaceId || "(none)"} interval=${heartbeatMs}ms`)
    while (!disposed) {
      // 每轮重读文件：agent 重新 add/换 ID 后无需重启
      const id = readWorkspaceId(directory)
      if (id !== workspaceId) {
        workspaceId = id
        log(`workspace id ${id ? `updated: ${id}` : "cleared"}`)
      }
      if (workspaceId) {
        try {
          await swarm.heartbeat(workspaceId, currentSessionId || undefined)
        } catch (e) {
          log(`heartbeat failed: ${e}`)
        }
      }
      await new Promise((r) => setTimeout(r, heartbeatMs))
    }
  }

  heartbeatLoop()

  return {
    // 跟踪当前会话 id（心跳上报用）
    event: async ({ event }) => {
      const anyEvt = event as any
      const sid = anyEvt?.properties?.sessionID ?? anyEvt?.info?.sessionID
      if (typeof sid === "string" && sid) currentSessionId = sid
    },

    dispose: async () => {
      disposed = true
      log("disposed")
    },
  }
}

export default plugin
