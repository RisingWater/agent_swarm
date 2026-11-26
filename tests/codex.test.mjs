import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { setImmediate as tick } from "node:timers/promises"
import { test } from "node:test"
import { AppServer } from "../plugins/codex/app-server.mjs"
import { executeTask } from "../plugins/codex/background.mjs"
import { serveMcp } from "../plugins/codex/swarm-mcp.mjs"
import { taskQueue } from "../plugins/codex/worker.mjs"
import { startNexusA2AClient } from "../plugins/claude/nexus_a2a.mjs"

function server(mode) {
  return spawn(process.execPath, ["-e", `
    const readline = require('node:readline')
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
    const notify = (method, params) => send({ method, params: { threadId: 'thread', turnId: 'turn', ...params } })
    const item = (type, id, props = {}) => ({ item: { type, id, ...props } })
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { method, id } = JSON.parse(line)
      if (method === 'initialize') {
        process.stderr.write('diagnostics\\n')
        send({ id, result: {} })
      } else if (method === 'unknown') {
        send({ id, error: { message: 'Unknown method' } })
      } else if (method === 'thread/start') {
        send({ id, result: { thread: { id: 'thread' } } })
      } else if (method === 'turn/start') {
        notify('turn/started', { turn: { id: 'turn' } })
        send({ id, result: { turn: { id: 'turn' } } })
        if (process.argv[1] === 'approval') {
          send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} })
          return
        }
        if (process.argv[1] === 'cancel') return
        notify('item/agentMessage/delta', { threadId: 'other', itemId: 'other', delta: 'ignored' })
        notify('item/completed', item('agentMessage', 'one', { phase: 'commentary', text: 'Checking' }))
        notify('item/started', item('commandExecution', 'tool', { command: 'echo PONG' }))
        notify('item/commandExecution/outputDelta', { itemId: 'tool', delta: 'PONG' })
        notify('item/completed', item('commandExecution', 'tool', { status: 'completed', exitCode: 0 }))
        notify('item/reasoning/textDelta', { itemId: 'private', delta: 'ignore' })
        notify('item/agentMessage/delta', { itemId: 'two', delta: 'PO' })
        notify('item/completed', item('agentMessage', 'two', { phase: 'final_answer', text: 'PONG' }))
        notify('item/completed', item('agentMessage', 'two', { phase: 'final_answer', text: 'PONG' }))
        notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
      } else if (method === 'turn/interrupt') {
        send({ id, result: {} })
        notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } })
      }
    })
  `, mode], { stdio: ["pipe", "pipe", "pipe"] })
}

test("App Server 握手、并行请求、错误、超时、关闭", async () => {
  const app = new AppServer(server("rpc"))
  try {
    await app.initialize()
    const [thread] = await Promise.all([
      app.call("thread/start", {}),
      assert.rejects(app.call("unknown", {}), /Unknown method/),
      assert.rejects(app.call("timeout", {}, 20), /超时/),
    ])
    assert.equal(thread.thread.id, "thread")
    assert.match(app.stderr, /diagnostics/)
    const pending = app.call("pending", {})
    app.close()
    await assert.rejects(pending, /关闭/)
  } finally {
    app.close()
  }
})

const job = { taskId: "task", contextId: "context", messageId: "message", caller: "peer", text: "PONG" }

test("只回传对应 turn 的可见事件和最终文本", async () => {
  const events = []
  const state = await executeTask(job, process.cwd(), event => events.push(event), new AbortController().signal, () => server("success"))
  assert.equal(state, "completed")
  assert.deepEqual(events.filter(e => e.kind === "artifact-update").map(e => e.artifact.parts[0].text), ["PONG"])
  assert.equal(events.filter(e => e.final).length, 1)
  assert.equal(events.find(e => e.metadata?.tool_state === "completed").metadata.output, "PONG")
  assert.equal(events.filter(e => e.metadata?.part_id === "two").length, 2)
  assert.doesNotMatch(JSON.stringify(events), /ignored|private/)
})

test("后台权限等待失败且不发送批准", async () => {
  const events = []
  const state = await executeTask(job, process.cwd(), event => events.push(event), new AbortController().signal, () => server("approval"))
  assert.equal(state, "failed")
  assert.match(events.at(-1).status.message.parts[0].text, /人工交互/)
})

test("取消正在执行的 turn 只回传一个 canceled 终态", async () => {
  const controller = new AbortController()
  const events = []
  const state = await executeTask(job, process.cwd(), event => {
    events.push(event)
    if (event.status.state === "working") setImmediate(() => controller.abort())
  }, controller.signal, () => server("cancel"))
  assert.equal(state, "canceled")
  assert.deepEqual(events.filter(e => e.final).map(e => e.status.state), ["canceled"])
})

test("按顺序执行、取消排队任务、接单去重及重启保护", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-codex-test-"))
  try {
    const started = [], emitted = []
    let release
    const hold = new Promise(resolve => { release = resolve })
    const execute = async task => {
      started.push(task.taskId)
      if (task.taskId === "a") await hold
      return "completed"
    }
    const queue = taskQueue(dir, execute, event => emitted.push(event))
    for (const taskId of ["a", "b", "a", "c"]) queue.queue({ taskId }, "text", "caller")
    queue.cancel("b")
    await tick()
    assert.deepEqual(started, ["a"])
    assert.equal(emitted[0].status.state, "canceled")
    release()
    await tick()
    await tick()
    assert.deepEqual(started, ["a", "c"])
    queue.close()
    const restarted = taskQueue(dir, execute, event => emitted.push(event))
    restarted.queue({ taskId: "a" }, "text", "caller")
    await tick()
    assert.deepEqual(started, ["a", "c"])
    assert.equal(emitted.at(-1).status.state, "completed")
    restarted.close()

    let aborted = false
    const closing = taskQueue(dir, async (task, signal) => {
      await once(signal, "abort")
      aborted = true
      return "canceled"
    }, event => emitted.push(event))
    closing.queue({ taskId: "d" }, "text", "caller")
    await tick()
    await closing.close()
    assert.ok(aborted)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("MCP 桥复用中心工具并只发送 Swarm API Key", async t => {
  const input = new PassThrough(), output = new PassThrough()
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const request = JSON.parse(options.body)
    assert.equal(url.href, "https://example.test/mcp/")
    assert.equal(options.headers.Authorization, "Bearer test-key")
    assert.equal(request.method, "tools/list")
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "list_workspaces" }] } })
  })
  serveMcp({ server: "https://example.test", apiKey: "test-key" }, input, output)
  const data = once(output, "data")
  input.end('{"method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":"tools","method":"tools/list"}\n')
  assert.equal(JSON.parse((await data)[0]).result.tools[0].name, "list_workspaces")
  assert.equal(globalThis.fetch.mock.callCount(), 1)
})

test("Swarm WS 重连后在 hello_ok 之后补发终态", async t => {
  const sockets = []
  class Socket extends EventTarget {
    static OPEN = 1
    sent = []
    readyState = 0
    constructor() { super(); sockets.push(this) }
    send(data) { this.sent.push(JSON.parse(data)) }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")) }
    accept() { this.dispatchEvent(new MessageEvent("message", { data: '{"type":"hello_ok"}' })) }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")) }
  }
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const realSocket = globalThis.WebSocket
  globalThis.WebSocket = Socket
  const nexus = startNexusA2AClient({
    url: "ws://test", apiKey: "key", workspaceId: () => "workspace",
    log() {}, executionMode: "background",
  })
  try {
    sockets[0].open()
    sockets[0].accept()
    sockets[0].close()
    nexus.sendEvent({ kind: "status-update", taskId: "one", final: true })
    t.mock.timers.tick(1000)
    sockets[1].open()
    assert.deepEqual(sockets[1].sent.map(frame => frame.type), ["hello"])
    sockets[1].accept()
    assert.deepEqual(sockets[1].sent.map(frame => frame.type), ["hello", "event"])
    assert.equal(sockets[1].sent[0].execution_mode, "background")
    assert.equal(sockets[1].sent[1].payload.taskId, "one")
  } finally {
    nexus.close()
    globalThis.WebSocket = realSocket
  }
})
