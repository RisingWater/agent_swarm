#!/usr/bin/env node
/** agent_swarm hooks 注册：把 PreToolUse/PostToolUse/Stop 三个事件合并进
 * ~/.claude/settings.json（幂等，保留用户已有字段——env/theme 等）。
 * 由 install-claude.ps1 / install-claude.sh 调用：
 *   node merge-hooks.mjs <settings.json 路径> <hook-timeline.mjs 路径>
 * 必须用 node 而非 PowerShell 原生 JSON：PS 5.1 无 -AsHashtable，原生合并
 * 曾把用户 settings.json 覆盖丢失（env 丢失事故 2026-09-13）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const [settingsPath, hookScript] = process.argv.slice(2)
if (!settingsPath || !hookScript) {
  console.error("usage: node merge-hooks.mjs <settings.json> <hook-timeline.mjs>")
  process.exit(1)
}

let settings = {}
try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")) } catch { settings = {} }
if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {}

const marker = "hook-timeline.mjs"
let changed = false
for (const evt of ["PreToolUse", "PostToolUse", "Stop"]) {
  if (!Array.isArray(settings.hooks[evt])) settings.hooks[evt] = []
  const exists = settings.hooks[evt].some((grp) =>
    (grp.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(marker) && (h.args ?? []).includes(evt)),
  )
  if (exists) continue
  settings.hooks[evt].push({ hooks: [{ type: "command", command: "node", args: [hookScript, evt] }] })
  changed = true
  console.log(`    已注册 hooks 事件 ${evt}`)
}
if (changed) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  console.log(`==> 已写入 hooks 到 ${settingsPath}`)
} else {
  console.log("==> hooks 已注册，跳过")
}
