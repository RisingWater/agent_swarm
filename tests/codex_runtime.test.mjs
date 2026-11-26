// 独立运行 node --test tests/codex_runtime.test.mjs，使用 PATH 中的真实 Codex CLI。
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { AppServer, launchCodex } from "../plugins/codex/app-server.mjs"
import { executeTask } from "../plugins/codex/background.mjs"
import { callTool } from "../plugins/codex/swarm-mcp.mjs"

test("Codex 发现新装技能，升级与卸载保留用户的技能", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "swarm-codex-skills-"))
  const env = { ...process.env, CODEX_HOME: home, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
    AGENT_SWARM_CODEX_SERVER: "http://127.0.0.1:8700", AGENT_SWARM_CODEX_KEY: "test-key" }
  function install(...args) {
    if (process.platform === "win32") {
      const run = spawnSync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "plugins/codex/install-codex.ps1",
        ...(args.length ? ["-Uninstall"] : ["-Server", env.AGENT_SWARM_CODEX_SERVER, "-ApiKey", env.AGENT_SWARM_CODEX_KEY]),
      ], { env, encoding: "utf8" })
      assert.equal(run.status, 0, run.stderr)
      return
    }
    const run = spawnSync(process.execPath, ["plugins/codex/install.mjs", ...args], { env, encoding: "utf8" })
    assert.equal(run.status, 0, run.stderr)
  }
  const skill = name => join(home, "skills", name, "SKILL.md")
  try {
    install()
    const app = new AppServer(launchCodex(["app-server", "--listen", "stdio://"], { env, cwd: home }))
    try {
      await app.initialize()
      const { data } = await app.call("skills/list", { cwds: [home] })
      const names = new Set(data.flatMap(entry => entry.skills.map(item => item.name)))
      for (const suffix of ["add", "register", "add-planner", "enable", "disable", "remove", "list", "notes"]) {
        assert.ok(names.has("swarm-" + suffix), JSON.stringify([...names]))
      }
    } finally {
      await app.close()
    }
    const modified = "---\nname: swarm-notes\ndescription: User customization\n---\n"
    await writeFile(skill("swarm-notes"), modified)
    install()
    assert.equal(await readFile(skill("swarm-notes"), "utf8"), modified)
    install("--uninstall")
    await assert.rejects(readFile(skill("swarm-add")), { code: "ENOENT" })
    assert.equal(await readFile(skill("swarm-notes"), "utf8"), modified)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function withMockCodex(run) {
  const dir = await mkdtemp(join(tmpdir(), "swarm-codex-runtime-"))
  const home = join(dir, "home")
  const cwd = join(dir, "project")
  await Promise.all([mkdir(home), mkdir(cwd)])
  let requests = 0
  const model = createServer((req, res) => {
    req.resume()
    if (req.url !== "/v1/responses") {
      res.writeHead(404).end()
      return
    }
    requests++
    const item = { id: "msg_1", type: "message", role: "assistant", phase: "final_answer" }
    const output = { type: "output_text", text: "PONG", annotations: [] }
    const frames = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", item: { ...item, content: [] } },
      { type: "response.output_text.delta", delta: "PONG" },
      { type: "response.output_item.done", item: { ...item, content: [output] } },
      { type: "response.completed", response: { id: "resp_1" } },
    ]
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""))
  })
  try {
    model.listen(0, "127.0.0.1")
    await once(model, "listening")
    await writeFile(join(home, "config.toml"), `
model = "mock-model"
model_provider = "mock"
approval_policy = "on-request"
sandbox_mode = "read-only"
[model_providers.mock]
name = "Local test fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`)
    await run({ dir, home, cwd, requests: () => requests, env: {
      ...process.env, CODEX_HOME: home, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1",
    } })
  } finally {
    model.closeAllConnections()
    model.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 150 })
  }
}

test("真实 Codex App Server 以本地模拟模型流处理后台任务", { timeout: 40_000 }, () => withMockCodex(async fixture => {
  const control = new AbortController()
  const deadline = setTimeout(() => control.abort(), 25_000)
  let child
  try {
    const events = []
    const result = await executeTask(
      { taskId: "runtime", contextId: "runtime", caller: "integration-test", text: "Reply PONG" },
      fixture.cwd, event => events.push(event), control.signal,
      (args, opts) => {
        child = launchCodex(args, { ...opts, env: fixture.env })
        return child
      },
    )
    assert.equal(result, "completed", JSON.stringify(events.at(-1)))
    assert.equal(fixture.requests(), 1)
    assert.equal(events.find(event => event.kind === "artifact-update")?.artifact.parts[0].text, "PONG")
  } finally {
    clearTimeout(deadline)
    if (child?.pid && child.exitCode === null && child.signalCode === null) await once(child, "close")
  }
}))

async function until(check) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await check()
    if (value) return value
    await delay(125)
  }
  throw new Error("等待集成测试状态超时")
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await once(child, "close")
}

const python = process.env.SWARM_CODEX_TEST_PYTHON
test("Swarm → MCP/WS → Codex worker → 最终结果", { skip: !python, timeout: 60_000 }, () => withMockCodex(async fixture => {
  const central = spawn(python, ["-u", "-c", `
import socket
import uvicorn
from server.main import app
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1], flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="error")).run(sockets=[sock])
`], { env: { ...fixture.env, AGENT_SWARM_DB: join(fixture.dir, "swarm.db") }, stdio: ["ignore", "pipe", "inherit"] })
  let worker, bridge
  try {
    const portLine = once(createInterface({ input: central.stdout }), "line")
    const [port] = await Promise.race([
      portLine,
      once(central, "exit").then(([code]) => { throw new Error(`Swarm exited (${code})`) }),
    ])
    const server = `http://127.0.0.1:${Number(port)}`
    await until(async () => (await fetch(server + "/health").catch(() => null))?.ok)
    const registered = await fetch(server + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-codex", password: "fixture-password" }),
    })
    assert.equal(registered.status, 201)
    const config = { server, apiKey: (await registered.json()).api_key }
    let install = spawnSync(process.execPath, ["plugins/codex/install.mjs"], {
      env: { ...fixture.env, AGENT_SWARM_CODEX_SERVER: server, AGENT_SWARM_CODEX_KEY: config.apiKey }, encoding: "utf8",
    })
    assert.equal(install.status, 0, install.stderr)
    const installed = join(fixture.home, "agent-swarm", "codex")
    bridge = spawn(process.execPath, [join(installed, "swarm-mcp.mjs")], { env: fixture.env })
    const lines = createInterface({ input: bridge.stdout })
    async function mcp(request) {
      const response = once(lines, "line")
      bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, ...request }) + "\n")
      return JSON.parse((await response)[0])
    }
    await mcp({ method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" },
    } })
    const listed = await mcp({ method: "tools/list", params: {} })
    assert.ok(listed.result.tools.some(tool => tool.name === "a2a_call"))
    worker = spawn(process.execPath, [join(installed, "worker.mjs"), fixture.cwd], {
      env: fixture.env, stdio: ["ignore", "pipe", "pipe"],
    })
    const workerLines = createInterface({ input: worker.stderr })
    await Promise.race([
      (async () => {
        const diagnostics = []
        for await (const line of workerLines) {
          if (line === "nexus a2a ready") return
          diagnostics.push(line)
        }
        throw new Error(`Codex worker exited before connecting: ${diagnostics.join("\n")}`)
      })(),
      delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Codex worker connection timed out") }),
    ])
    const { workspace_id: from } = await callTool(config, "workspace_add", { path: "/fixture/sender" })
    const { workspaces } = await callTool(config, "list_workspaces", { include_offline: true })
    const target = workspaces.find(workspace => workspace.agent_type === "codex")?.workspace_id
    assert.ok(target)
    const rpc = await mcp({ method: "tools/call", params: { name: "a2a_call", arguments: {
      target, from_workspace: from, context_id: "fixture-context", message: "Reply PONG", wait_seconds: 10,
    } } })
    assert.equal(rpc.result?.isError, false, JSON.stringify(rpc))
    const task = rpc.result.structuredContent ?? JSON.parse(rpc.result.content[0].text)
    assert.equal(task.status, "completed", JSON.stringify(task))
    assert.equal(task.context_id, "fixture-context")
    assert.equal(task.result, "PONG")
    assert.equal(fixture.requests(), 1)
    bridge.stdin.end()
    await once(bridge, "close")
    await stop(worker)
    install = spawnSync(process.execPath, [join(installed, "install.mjs"), "--uninstall"], { env: fixture.env, encoding: "utf8" })
    assert.equal(install.status, 0, install.stderr)
  } finally {
    await stop(bridge)
    await stop(worker)
    await stop(central)
  }
}))
