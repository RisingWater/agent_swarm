# Codex 适配器

安装后仍运行 `codex`。用 `/mcp` 查看 `agent-swarm`，从 `/skills` 选择 `swarm-add` 或在对话里输入 `$swarm-add` 注册当前目录。派单时用该工作区 ID 作为 `from_workspace`。长任务可先用 `wait_seconds=0` 取得任务 ID，再通过 `a2a_task` 查询结果。

## 安装和卸载

需要 Node.js 22+、Codex CLI 0.170+ 和已部署本版本的 Swarm 服务。本次在 Windows npm 安装的 0.172.0 上验证。只安装 Codex 时使用现有分发器的筛选参数。

```powershell
& ([scriptblock]::Create((irm https://<server>/download/install.ps1))) -ApiKey <your-key> -Only codex
```

```bash
curl -fsSL https://<server>/download/install.sh | bash -s -- --api-key <your-key> --only codex
```

安装用官方 `codex mcp add` 写入一个 stdio MCP 入口，并在 `$CODEX_HOME/skills` 安装快捷技能。已有同名技能和用户修改过的技能会保留。其余 Codex 配置和登录由 Codex 管理。同名 MCP 已由用户配置时，安装会保留原配置并报错。适配器只用 Swarm API Key 访问中心，密钥保存在当前用户的 `$CODEX_HOME/agent-swarm/codex/swarm.json`，POSIX 文件权限为 `0600`，Windows 继承用户目录 ACL。未设置 `CODEX_HOME` 时使用 `~/.codex`。

卸载前结束已启动的后台 worker。使用安装路径下的 `install.mjs` 移除 MCP 入口、程序文件和由安装器管理的技能。工作区、调用记录及仅保存任务 ID 哈希和状态的本地去重记录会保留。

```powershell
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
node (Join-Path $codexDir "agent-swarm/codex/install.mjs") --uninstall
```

```bash
node "${CODEX_HOME:-$HOME/.codex}/agent-swarm/codex/install.mjs" --uninstall
```

## 会话快捷入口

| 在 Codex 中输入 | 功能 |
| --- | --- |
| `$swarm-add`、`$swarm-register` | 注册当前目录并保存工作区 ID |
| `$swarm-add-planner` | 以规划器角色注册当前目录 |
| `$swarm-enable`、`$swarm-disable` | 启用或禁用当前工作区 |
| `$swarm-remove` | 移除当前工作区 |
| `$swarm-list`、`$swarm-notes` | 查看可见工作区，或更新当前工作区备注 |
| `$swarm-bind` | 将当前会话设置为工作区的前台接单会话 |

快捷入口使用 [Codex 原生技能](https://developers.openai.com/codex/skills)。中枢的 Codex 在线状态对应负责接单的 worker。

## 接收任务

启动 `codex` 后，Codex 拉起的 `agent-swarm` MCP 子进程会自动在会话工作目录启动后台 worker，不需要再手动运行命令。worker 使用同一个 Codex 工作区上报心跳并连接 `/ws/plugin`，MCP 子进程结束时随之退出。若同一目录此前已注册为其他适配器，先断开原适配器，再用 `$swarm-add` 注册为 Codex；Swarm 沿用工作区 ID、角色和历史。

也可以单独运行 worker 处理某个目录（例如不开 TUI 的后台机器），命令与之前相同：

```powershell
node (Join-Path $codexDir "agent-swarm/codex/worker.mjs") "C:/work/project"
```

```bash
node "${CODEX_HOME:-$HOME/.codex}/agent-swarm/codex/worker.mjs" "/path/to/project"
```

worker 通过现有 `/ws/plugin` 串行接单，流式回传可见文本、工具事件和最终答复。默认每个任务使用独立的临时 App Server Thread，需要交互的审批或提问会结束后台任务。自动启动的 worker 日志写在安装目录的 `worker.log`。

### 将任务投递到 Codex TUI

使用共享 App Server 的会话通过官方 Proxy 接收任务并实时回传。共享服务连接不上时（例如 Windows 管理员窗口使用内置 App Server），适配器通过官方独立 App Server 提交到 Codex 自己的队列，再从对应会话的历史读取答复。内置模式下请保持目标 TUI 打开，Swarm 可以取消尚未执行的队列项。任务已经开始时，在 Codex 窗口中中断。

在想接单的 Codex 会话里完成一轮对话，再输入 `$swarm-bind`。技能使用 Codex 提供的当前会话 ID，无需手动复制或打开第二个终端。

如需从外部终端指定会话，在目标项目目录运行对应命令，使用目标会话 `/status` 中的 **Session ID**。

   ```powershell
   $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
   node (Join-Path $codexDir "agent-swarm/codex/worker.mjs") --bind-thread "<Session ID>"
   ```

   ```bash
   node "${CODEX_HOME:-$HOME/.codex}/agent-swarm/codex/worker.mjs" --bind-thread "<Session ID>"
   ```

绑定立即对该工作区的后续任务生效。消息和答复显示在绑定的会话中，最终答复同步回 Swarm。会话忙时由 Codex 排队，审批和提问继续由 Codex 处理。绑定保存在项目的 `.agent_swarm/codex-thread`，换会话时重新绑定。关闭 TUI 后，Codex daemon 可能继续保留并执行该会话。会话未加载时，打开原会话或重新绑定。用同一个命令将 `--bind-thread "<Session ID>"` 改为 `--clear-thread` 可恢复独立后台执行。

## Windows 可行性验证

| 项目 | 命令或观察 | 实际结果 |
| --- | --- | --- |
| 运行时与协议 | `codex --version`、`codex app-server --help`、`codex app-server generate-ts --experimental --out <临时目录>` | CLI 0.172.0。生成定义包含 Thread 枚举、恢复、排队、Turn 启动和中断，以及结构化事件。 |
| 默认 daemon | `codex app-server daemon version` | 初次探测默认用户控制套接字返回 Windows 10050。在隔离 `CODEX_HOME` 中配置本地模拟模型后，仅运行 `codex` 就自动启动了 0.172.0 daemon。 |
| 官方 Proxy | `codex app-server proxy` → HTTP WebSocket Upgrade → WebSocket 文本帧中的 `initialize` / `initialized` | 隔离 daemon 返回 HTTP 101，随后支持 `thread/loaded/list`、`thread/list`、`thread/read`。未知方法返回 `-32600`，重开 Proxy 可重新握手。直接写 JSONL 会超时，指定不存在的 `--sock` 返回 Windows 10061。 |
| TUI 与 Thread | 原版 TUI `/status` 对照 `thread/loaded/list` 和 `thread/read` | Session ID 一致。首次输入前，该 Thread 已加载但未入历史记录，此时 `thread/resume` 返回 `no rollout found`。首轮完成后，`thread/resume` 成功，并收到另一客户端的用户消息、答复增量与 Turn 终态。 |
| 外部排队 | `codex queue --thread <测试 UUID> --message "[Swarm test] Reply PONG."` | 空闲时原版 TUI 显示指令并自动执行。忙碌时任务进入队列，原 Turn 正常完成，随后在下一 Turn 执行排队指令。 |
| 内置 App Server | 用 `codex --no-daemon` 启动隔离测试会话，再用适配器绑定和派单 | 官方 Proxy 返回 10050。适配器通过独立 stdio App Server 的 `thread/queue/add` 送达已打开的 TUI，按提交 ID 从 `thread/turns/list` 读取对应 Turn，回传最终答复和终态。 |
| 多 TUI 和退出 | 在两个目录运行 `codex`，然后从第一个 TUI 执行 `/exit` | Proxy 同时发现两个 Thread。第一个 TUI 退出后，其 Thread 仍在 `thread/loaded/list` 中。测试中 TUI Thread 的 `source` 还显示为 `vscode`，无法用该字段识别原版 TUI。 |
| MCP 子进程生命周期 | 在隔离目录启动 Windows Codex 0.172.0，分别通过 `/exit` 和 `Ctrl+C` 退出 TUI | 普通 `codex` 由共享 daemon 持有 MCP 子进程，TUI 退出后子进程仍运行。使用 `codex --no-daemon` 时，两种退出方式都结束了 MCP 子进程。该试验仅验证进程生命周期；代码据此让 worker 跟随 MCP 子进程启动和退出。 |
| daemon 重启 | 对隔离 daemon 执行 `codex app-server daemon restart`，再重连 Proxy | 握手成功。仍开着的 TUI Thread 出现在已加载列表里，已退出的 Thread 在历史中标为 `notLoaded`。 |
| 独立 App Server | `codex app-server --listen stdio://` | `initialize`、`initialized`、`thread/loaded/list`、`thread/list`、未知方法错误及 `thread/start` 已实测。调用 `turn/start` 后通过本地模拟模型返回流式答复和 `completed`。 |
| 安装 | 隔离 `CODEX_HOME` 中运行安装、重复安装、`codex mcp get agent-swarm --json`、卸载 | 正常创建并移除专用入口。测试使用本地模拟模型与测试 Swarm Key。 |

在隔离环境中，临时 Swarm 服务派发中文消息，worker 通过 Proxy 投递到绑定的真实 TUI。TUI 显示消息和模拟模型的答复，Swarm 收到最终文本并将任务标为完成。绑定以 Session ID 为准，前台 Monitor 尚未接入。跨客户端工具审批分发及 daemon 重启期间的在途任务恢复尚未验证。

执行 `node --test tests/codex.test.mjs tests/codex_runtime.test.mjs` 可重跑协议模拟和真实 CLI 后台测试。将 `SWARM_CODEX_TEST_PYTHON` 指向已安装项目依赖的 Python 解释器后，同一命令还会启动临时 Swarm 服务并验证派单、MCP 桥接、WS 与最终答复。集成测试使用临时回环端口，生产适配器通过 stdio 与 App Server 通信。

官方实现与协议见 [Codex CLI 0.172.0 Proxy](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/cli/src/app_server_proxy.rs) 和 [App Server 0.172.0 文档](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server/README.md)。
