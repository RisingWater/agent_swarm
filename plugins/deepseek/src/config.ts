/** deepseek 插件配置：~/.config/dsh/agent-swarm.json（install-deepseek 脚本写入），
 * 兜底环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY。
 * executionMode：foreground=注入最近活跃会话（所见即所得）；background=per-caller 专属会话。
 * /swarm-mode 命令热切换时直接改写本文件（对齐 opencode 插件的做法）。 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ExecutionMode = "foreground" | "background"

export interface SwarmConfig {
  serverUrl: string
  apiKey: string
  executionMode: ExecutionMode
}

export const CONFIG_PATH = join(homedir(), ".config", "dsh", "agent-swarm.json")

interface RawConfig {
  serverUrl?: string
  apiKey?: string
  executionMode?: string
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
  const cfg = readJson(CONFIG_PATH)
  const out: SwarmConfig = {
    serverUrl: cfg.serverUrl ?? process.env.AGENT_SWARM_SERVER ?? "http://127.0.0.1:8700",
    apiKey: cfg.apiKey ?? process.env.AGENT_SWARM_API_KEY ?? "",
    executionMode: cfg.executionMode === "background" ? "background" : "foreground",
  }
  if (!out.apiKey) return null
  return out
}

/** /swarm-mode 热切换：改写配置文件（下次 loadConfig 读到新值） */
export function saveExecutionMode(mode: ExecutionMode): boolean {
  try {
    const cfg = readJson(CONFIG_PATH)
    cfg.executionMode = mode
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8")
    return true
  } catch {
    return false
  }
}
