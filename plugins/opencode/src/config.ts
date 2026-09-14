/** 插件配置加载：~/.config/opencode/agent-swarm.json 优先，其次插件目录内 config.json，
 * 最后环境变量（两处文件都不存在时兜底）。 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SwarmConfig } from "./client"

function readJson(path: string): Partial<SwarmConfig> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return {} // 配置文件损坏时忽略，继续读下一来源
  }
}

export function loadConfig(): SwarmConfig | null {
  // 全局配置（install-opencode.sh|.ps1 写入）
  const globalCfg = readJson(join(homedir(), ".config", "opencode", "agent-swarm.json"))
  // 插件目录内配置（本文件在 <INSTALL_DIR>/src/config.js，配置在 <INSTALL_DIR>/config.json）
  const here = dirname(fileURLToPath(import.meta.url))
  const localCfg = readJson(join(here, "..", "config.json"))

  const cfg: SwarmConfig = {
    serverUrl:
      globalCfg.serverUrl ?? localCfg.serverUrl ?? process.env.AGENT_SWARM_SERVER ?? "http://127.0.0.1:8700",
    apiKey: globalCfg.apiKey ?? localCfg.apiKey ?? process.env.AGENT_SWARM_API_KEY ?? "",
    heartbeatIntervalMs: globalCfg.heartbeatIntervalMs ?? localCfg.heartbeatIntervalMs ?? 30_000,
  }
  if (!cfg.apiKey) return null
  return cfg
}
