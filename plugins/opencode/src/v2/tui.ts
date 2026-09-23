/** agent_swarm opencode V2 CLI 插件：/swarm-* 原生命令（弹窗交互，零 token）。
 *
 * V1 的 TUI 插件用 api.command.register + api.ui.DialogSelect；V2 换成
 * @opencode/plugin/tui 的 Plugin.define + context.keymap.layer + context.ui.dialog.select
 * + context.ui.toast.show。命令语义与 V1 完全一致：
 *   /swarm-mode    弹窗选择 foreground / background
 *   /swarm-monitor 开关前台会话实时监控
 *   /swarm-remove  删除本目录工作区（仅离线可删）→ 清 WORKSPACE_ID
 *   /swarm-enable  启用工作区
 *   /swarm-disable 禁用工作区
 * （/swarm-add 仍是 md 命令 commands/swarm-add.md，V2 同样支持。）
 *
 * server 地址与 apikey 读 ~/.config/opencode/agent-swarm.json（与 server 插件共用）；
 * workspace ID 读写 <项目根>/.agent_swarm/workspace.md。
 */

import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_FILE = join(homedir(), ".config", "opencode", "plugins", "agent-swarm", "plugin.log")

/** 追加到插件日志（与 server 插件共用 plugin.log），便于排查 CLI 插件加载 */
function tuiLog(msg: string) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [tui-v2] ${msg}\n`)
  } catch {
    /* 日志失败不致命 */
  }
}

const CFG_PATH = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME.replace(/[\\/]+$/, ""), "opencode", "agent-swarm.json")
  : join(homedir(), ".config", "opencode", "agent-swarm.json")

interface SwarmCfg {
  serverUrl?: string
  apiKey?: string
  executionMode?: string
  backgroundCommand?: string
  monitor?: boolean
}

function readCfg(): SwarmCfg {
  try {
    return JSON.parse(readFileSync(CFG_PATH, "utf8"))
  } catch {
    return {}
  }
}

function writeCfg(cfg: SwarmCfg): boolean {
  try {
    writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + "\n")
    return true
  } catch {
    return false
  }
}

async function swarmApi<T>(path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const cfg = readCfg()
  const base = (cfg.serverUrl ?? "").replace(/\/+$/, "")
  if (!base || !cfg.apiKey) return { ok: false, status: 0, data: null, error: "插件未配置（缺 agent-swarm.json）" }
  try {
    const rsp = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = (await rsp.json().catch(() => null)) as T | null
    if (!rsp.ok) {
      const detail = (data as any)?.detail ?? `HTTP ${rsp.status}`
      return { ok: false, status: rsp.status, data, error: String(detail) }
    }
    return { ok: true, status: rsp.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) }
  }
}

/** 项目根的 .agent_swarm/workspace.md 读写 */
function swarmFile(worktree: string) {
  const root = worktree.replace(/[\\/]+$/, "")
  const dir = `${root}/.agent_swarm`
  const path = `${dir}/workspace.md`
  const read = (): string => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return ""
    }
  }
  const mkdir = () => {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* 已存在竞态 */
      }
    }
  }
  const ensure = (workspaceId: string) => {
    if (read() === "") {
      mkdir()
      writeFileSync(path, `# agent_swarm\n\nPURPOSE: \nCAPABILITIES: \nWORKSPACE_ID: ${workspaceId}\n`, "utf-8")
    }
  }
  const setLine = (key: string, value: string | null) => {
    let text = read()
    if (text === "") {
      ensure("")
      text = read()
    }
    const re = new RegExp(`^${key}:.*$`, "m")
    if (value === null) {
      text = text.replace(new RegExp(`^${key}:.*\\n?`, "m"), "")
    } else if (re.test(text)) {
      text = text.replace(re, `${key}: ${value}`)
    } else {
      text = text.replace(/\s*$/, "") + `\n${key}: ${value}\n`
    }
    mkdir()
    writeFileSync(path, text)
  }
  const getLine = (key: string): string => {
    const m = read().match(new RegExp(`^${key}:\\s*(.*)$`, "m"))
    return m?.[1]?.trim() ?? ""
  }
  return { path, read, setLine, getLine, ensure }
}

const MODE_LABEL: Record<string, string> = {
  foreground: "前台（注入当前 TUI 会话）",
  background: "后台（独立 headless 进程执行）",
}

export default Plugin.define({
  id: "agent-swarm-cli",
  setup(context) {
    const worktree = context.location?.directory ?? process.cwd()
    const file = swarmFile(worktree)
    tuiLog(`loaded: worktree=${worktree} version=${context.app.version}`)

    const toastErr = (e: string) => context.ui.toast.show({ variant: "error", message: e, duration: 6000 })
    const toastOk = (message: string) => context.ui.toast.show({ variant: "success", message, duration: 5000 })

    // keymap.layer 需要一个组件上下文（直接调会报 "Keymap.Provider is missing"），
    // 因此挂到 app 插槽的 render 里注册（官方 session.panel 示例同款写法）。
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
        {
          id: "agent-swarm.mode",
          title: "Swarm: Execution Mode",
          group: "agent_swarm",
          description: "切换 A2A 任务执行模式（前台/后台）",
          slash: { name: "swarm-mode" },
          run: async () => {
            const cfg = readCfg()
            if (!cfg.serverUrl || !cfg.apiKey) {
              toastErr("agent_swarm 插件未配置，请先运行安装命令")
              return
            }
            const picked = await context.ui.dialog.select({
              title: "任务执行模式",
              options: (Object.keys(MODE_LABEL) as string[]).map((m) => ({
                title: `${cfg.executionMode === m ? "● " : "○ "}${MODE_LABEL[m]}`,
                value: m,
              })),
              current: cfg.executionMode ?? "foreground",
            })
            if (picked === undefined) return
            const next = String(picked)
            if (writeCfg({ ...readCfg(), executionMode: next })) {
              toastOk(`执行模式: ${MODE_LABEL[next]}（下一个 A2A 任务生效）`)
            } else {
              toastErr("写入配置失败")
            }
          },
        },
        {
          id: "agent-swarm.monitor",
          title: "Swarm: Monitor TUI Session",
          group: "agent_swarm",
          description: "切换前台会话实时监控（对话轮次上报 web 中枢）",
          slash: { name: "swarm-monitor" },
          run: async () => {
            const cfg = readCfg()
            const picked = await context.ui.dialog.select({
              title: "前台会话实时监控",
              options: [
                { title: `${cfg.monitor !== false ? "● " : "○ "}开启（TUI 对话实时上报中枢）`, value: "on" },
                { title: `${cfg.monitor === false ? "● " : "○ "}关闭`, value: "off" },
              ],
              current: cfg.monitor === false ? "off" : "on",
            })
            if (picked === undefined) return
            const next = String(picked) === "on"
            if (writeCfg({ ...readCfg(), monitor: next })) {
              toastOk(`实时监控: ${next ? "开启" : "关闭"}（立即生效）`)
            } else {
              toastErr("写入配置失败")
            }
          },
        },
        {
          id: "agent-swarm.remove",
          title: "Swarm: Remove Workspace",
          group: "agent_swarm",
          description: "删除本目录注册的工作区（仅离线可删）",
          slash: { name: "swarm-remove" },
          run: async () => {
            const wid = file.getLine("WORKSPACE_ID")
            if (!wid) {
              toastErr(".agent_swarm/workspace.md 没有 WORKSPACE_ID（本目录未注册）")
              return
            }
            const rsp = await swarmApi(`/api/workspaces/${wid}`, "DELETE")
            if (rsp.status === 409) {
              toastErr("工作区在线/最近心跳，不能删除——先停掉本目录的 opencode 再试")
              return
            }
            if (!rsp.ok) {
              toastErr(`删除失败: ${rsp.error}`)
              return
            }
            file.setLine("WORKSPACE_ID", null)
            toastOk(`已删除 ${wid}`)
          },
        },
        {
          id: "agent-swarm.disable",
          title: "Swarm: Disable Workspace",
          group: "agent_swarm",
          description: "禁用工作区（不参与任务接收）",
          slash: { name: "swarm-disable" },
          run: async () => {
            const wid = file.getLine("WORKSPACE_ID")
            if (!wid) {
              toastErr(".agent_swarm/workspace.md 没有 WORKSPACE_ID")
              return
            }
            const rsp = await swarmApi(`/api/workspaces/${wid}/disable`, "POST")
            if (rsp.ok) toastOk("已禁用")
            else toastErr(`禁用失败: ${rsp.error}`)
          },
        },
        {
          id: "agent-swarm.enable",
          title: "Swarm: Enable Workspace",
          group: "agent_swarm",
          description: "启用工作区",
          slash: { name: "swarm-enable" },
          run: async () => {
            const wid = file.getLine("WORKSPACE_ID")
            if (!wid) {
              toastErr(".agent_swarm/workspace.md 没有 WORKSPACE_ID")
              return
            }
            const rsp = await swarmApi(`/api/workspaces/${wid}/enable`, "POST")
            if (rsp.ok) toastOk("已启用，等插件心跳上线")
            else toastErr(`启用失败: ${rsp.error}`)
          },
        },
          ],
        }))
        return null
      },
    })
    tuiLog("commands registered via app slot (/swarm-mode, /swarm-monitor, /swarm-remove, /swarm-enable, /swarm-disable)")
  },
})
