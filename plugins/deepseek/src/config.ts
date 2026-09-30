/** deepseek 插件配置：~/.config/dsh/agent-swarm.json（install-deepseek 脚本写入），
 * 兜底环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY。 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface SwarmConfig {
  serverUrl: string
  apiKey: string
}

interface RawConfig {
  serverUrl?: string
  apiKey?: string
}

function readJson(path: string): RawConfig {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return {} // 配置文件损坏时忽略，继续读下一来源
  }
}

export function loadConfig(): SwarmConfig | null {
  const globalCfg = readJson(join(homedir(), ".config", "dsh", "agent-swarm.json"))
  const cfg: SwarmConfig = {
    serverUrl: globalCfg.serverUrl ?? process.env.AGENT_SWARM_SERVER ?? "http://127.0.0.1:8700",
    apiKey: globalCfg.apiKey ?? process.env.AGENT_SWARM_API_KEY ?? "",
  }
  if (!cfg.apiKey) return null
  return cfg
}
