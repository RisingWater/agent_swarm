/** 插件配置加载：~/.config/opencode/agent-swarm.json 优先，其次环境变量 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SwarmConfig } from "./client"

export function loadConfig(): SwarmConfig | null {
  let fileCfg: Partial<SwarmConfig> = {}
  const file = join(homedir(), ".config", "opencode", "agent-swarm.json")
  if (existsSync(file)) {
    try {
      fileCfg = JSON.parse(readFileSync(file, "utf-8"))
    } catch {
      // 配置文件损坏时忽略，继续读环境变量
    }
  }
  const cfg: SwarmConfig = {
    serverUrl:
      fileCfg.serverUrl ?? process.env.AGENT_SWARM_SERVER ?? "http://127.0.0.1:8700",
    apiKey: fileCfg.apiKey ?? process.env.AGENT_SWARM_API_KEY ?? "",
    heartbeatIntervalMs: fileCfg.heartbeatIntervalMs ?? 30_000,
  }
  if (!cfg.apiKey) return null
  return cfg
}
