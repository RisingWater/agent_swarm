/** agent_swarm opencode V2 插件（第一步：心跳上线冒烟）。
 *
 * V2 与 V1 的入口差异：
 *   V1: export const plugin: Plugin = async (input) => ({ event, dispose })
 *   V2: export default Plugin.define({ id, setup(ctx) }) —— 清理函数由 setup 返回
 * 目录从 ctx.location.directory 取（V1 是 input.directory）。
 *
 * 本阶段只做「心跳保活」，用于验证 V2 能加载插件、把工作区拉上线。A2A 任务、
 * 前台监控、权限/提问应答、/swarm-* 命令都在后续步骤接入（复用共享模块）。
 */

import { Plugin } from "@opencode/plugin"
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readWorkspaceId } from "../wsfile"
import { SwarmClient } from "../client"
import { loadConfig } from "../config"

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

export default Plugin.define({
  id: "agent-swarm",
  async setup(ctx) {
    const directory = ctx.location?.directory ?? process.cwd()
    const cfg = loadConfig()
    if (!cfg) {
      log("v2: no apiKey config; plugin disabled")
      return
    }
    const heartbeatMs = cfg.heartbeatIntervalMs ?? 30_000
    const swarm = new SwarmClient(cfg)
    const AGENT_TYPE = "opencode" // 本插件跑在 opencode 里，心跳固定上报

    let stopped = false
    log(`v2 start: directory=${directory} workspaceId=${readWorkspaceId(directory) || "(none)"} interval=${heartbeatMs}ms`)

    async function heartbeatLoop() {
      while (!stopped) {
        // 每轮重读文件：agent 重新 add/换 ID 后无需重启
        const workspaceId = readWorkspaceId(directory)
        if (workspaceId) {
          try {
            const rsp = await swarm.heartbeat(workspaceId, "", AGENT_TYPE, "")
            log(`v2 heartbeat ok: ws=${workspaceId} status=${rsp?.status ?? "?"}`)
          } catch (e) {
            log(`v2 heartbeat failed: ${e}`)
          }
        } else {
          log(`v2 heartbeat skipped: no WORKSPACE_ID（${directory}/.agent_swarm/workspace.md）`)
        }
        await new Promise((r) => setTimeout(r, heartbeatMs))
      }
    }
    void heartbeatLoop()

    return () => {
      stopped = true
      log("v2 disposed")
    }
  },
})
