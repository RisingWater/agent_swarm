import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { codexCommand } from "./app-server.mjs"

const name = "agent-swarm"
const root = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"), "agent-swarm")
const installed = join(root, "codex")
const bridge = join(installed, "swarm-mcp.mjs")
const sources = ["app-server.mjs", "swarm-mcp.mjs", "background.mjs", "worker.mjs", "install.mjs"]
const skillSources = fileURLToPath(new URL("./skills/", import.meta.url))
const skillBackups = join(installed, "skills")
const userSkills = resolve(root, "..", "skills")
const [bin, ...prefix] = codexCommand()

function cli(...args) {
  const result = spawnSync(bin, [...prefix, ...args], { encoding: "utf8", timeout: 20_000, windowsHide: true })
  if (result.error) throw new Error("无法执行 Codex CLI")
  return result
}

function installSkills(uninstall) {
  const definitions = uninstall ? skillBackups : skillSources
  if (!existsSync(definitions)) return
  for (const skill of readdirSync(definitions, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue
    const targetDir = join(userSkills, skill.name)
    const target = join(targetDir, "SKILL.md")
    const backupDir = join(skillBackups, skill.name)
    const backup = join(backupDir, "SKILL.md")
    const owned = existsSync(backup) && lstatSync(targetDir, { throwIfNoEntry: false })?.isDirectory()
      && lstatSync(target, { throwIfNoEntry: false })?.isFile()
      && readFileSync(target).equals(readFileSync(backup))
    if (uninstall) {
      if (owned) {
        rmSync(target)
        if (readdirSync(targetDir).length === 0) rmdirSync(targetDir)
      }
      rmSync(backup, { force: true })
      if (readdirSync(backupDir).length === 0) rmdirSync(backupDir)
      continue
    }
    if (lstatSync(targetDir, { throwIfNoEntry: false }) && !owned) {
      console.log(`保留已有 Codex 技能：${skill.name}`)
      continue
    }
    const source = join(definitions, skill.name, "SKILL.md")
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    copyFileSync(source, target)
    if (resolve(source) !== backup) copyFileSync(source, backup)
  }
}

function install() {
  const uninstall = process.argv.includes("--uninstall")
  const version = cli("--version")
  if (version.status !== 0) throw new Error("Codex CLI 版本检查失败")
  const entry = cli("mcp", "get", name, "--json")
  if (entry.status === 0) {
    const transport = JSON.parse(entry.stdout).transport
    if (transport?.type !== "stdio" || transport.args?.length !== 1 || transport.args[0] !== bridge) {
      throw new Error("Codex 中已配置同名 MCP，保留现有配置")
    }
  } else if (!entry.stderr.includes(`No MCP server named '${name}' found`)) {
    throw new Error("无法通过 Codex CLI 检查 MCP 配置")
  }
  if (uninstall) {
    if (entry.status === 0 && cli("mcp", "remove", name).status !== 0) {
      throw new Error("Codex MCP 配置卸载失败")
    }
    installSkills(true)
    for (const file of [...sources, "swarm.json"]) rmSync(join(installed, file), { force: true })
    rmSync(join(root, "claude", "nexus_a2a.mjs"), { force: true })
    console.log("已移除 Codex Swarm MCP 与适配器文件")
    return
  }
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("需要 Node.js 22 或以上版本")
  const server = new URL(process.env.AGENT_SWARM_CODEX_SERVER)
  if (!["https:", "http:"].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== "/") {
    throw new Error("Swarm 服务地址须为 HTTP(S) 源地址")
  }
  const apiKey = process.env.AGENT_SWARM_CODEX_KEY
  if (!apiKey) throw new Error("缺少 Swarm API Key")
  mkdirSync(installed, { recursive: true, mode: 0o700 })
  mkdirSync(join(root, "claude"), { recursive: true, mode: 0o700 })
  for (const file of sources) {
    const from = fileURLToPath(new URL(file, import.meta.url))
    const to = join(installed, file)
    if (from !== to) copyFileSync(from, to)
  }
  const shared = fileURLToPath(new URL("../claude/nexus_a2a.mjs", import.meta.url))
  const target = join(root, "claude", "nexus_a2a.mjs")
  if (shared !== target) copyFileSync(shared, target)
  const temp = join(installed, `swarm.${process.pid}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify({ server: server.origin, apiKey }), { mode: 0o600, flag: "wx" })
    chmodSync(temp, 0o600)
    renameSync(temp, join(installed, "swarm.json"))
  } finally {
    rmSync(temp, { force: true })
  }
  if (entry.status !== 0 && cli("mcp", "add", name, "--", process.execPath, bridge).status !== 0) {
    throw new Error("Codex MCP 配置写入失败")
  }
  installSkills(false)
  console.log("已安装 Codex Swarm MCP，启动命令仍为 codex")
  console.log("在 Codex 中用 /skills 或 $swarm-add 注册工作区")
  console.log(`独立后台工作区：node "${join(installed, "worker.mjs")}" "<工作目录>"`)
}

try { install() } catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
