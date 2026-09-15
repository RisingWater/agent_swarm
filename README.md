# agent_swarm

多 agent 协作中枢（虫群）：把你的 AI 编程工具（opencode 等）组成一个虫群，让它们互相调用、协同完成任务。

- **面向 agent 的操作全部是标准 MCP 工具**——opencode、claude、deepseek 等任何支持 MCP 的客户端都能接入
- **跨 agent 任务派发**：一条指令把任务交给另一个工作区的 agent，支持前台注入（实时可见）与后台会话（静默执行）两种方式，结果自动回传
- **Web 中枢**：网页上直接给在线工作区下达指令，实时观看 agent 思考、工具调用与答复；监控模式下你在 TUI 里的日常对话也会实时同步到网页
- **自托管 & 轻量**：单个 FastAPI 服务 + SQLite，一条命令启动，数据完全在自己机器上

## 架构

```
┌───────────────────────────── agent_swarm 服务端 (FastAPI, :8700) ─────────────────────────────┐
│  /            管理前端（web/dist 静态托管）                                                    │
│  /api/*       REST API（JWT 鉴权）：注册登录、账号、工作区、调用记录                            │
│  /mcp/        MCP 端点（Streamable HTTP + API Key 鉴权）：12 个面向 agent 的工具               │
│  /ws/plugin   中枢 WS（插件端）：指令下发 + timeline 事件上报（API Key 鉴权）                   │
│  /ws/nexus    中枢 WS（网页端）：订阅工作区时间线 + 下发指令（JWT 鉴权）                        │
│  /download/*  插件分发（免鉴权）：plugin.tar.gz / install.sh / install.ps1                     │
│  /health      健康检查                                                                        │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ 心跳(30s) + 领取任务                          ▲ MCP 工具调用（Bearer apikey）
        │                                              │
┌───────┴────────┐                              ┌──────┴─────────┐
│ opencode 插件   │                              │ 任意 MCP 客户端 │
│ (agent 机器上)  │                              │ (agent 内直接用)│
└────────────────┘                              └────────────────┘
```

- **服务端** `server/`：FastAPI 单体。SQLite（`data/agent_swarm.db`）存用户/工作区/调用记录/中枢时间线事件
- **插件** `plugins/`：每个 agent 工具一个子目录，统一由分发器安装
  - `plugins/opencode/`：opencode 插件（TS）。心跳保活 + 接收跨 agent 任务（前台注入：任务直接进当前 TUI 会话实时可见；后台会话：独立 headless 进程静默执行，按来源归组续聊）+ 前台会话监控（TUI 日常对话按轮次实时上报网页中枢）+ 中枢 WS 直连（接收网页指令、上报 timeline 事件）
  - `plugins/claude/`：claude code 接入。本地 keepalive MCP server（spawn 即心跳保活）+ 后台会话任务执行（`claude -p` headless）+ `/swarm-*` 命令。claude 仅支持后台会话，无前台注入
- **前端** `web/`：React + Vite 管理端（首页、文档、**中枢**、工作区看板、调用记录、账号管理）

## 快速开始

### 1. 启动服务端

```bash
# Linux / macOS
./deploy/start.sh                # 默认 :8700，自动建 venv、装依赖、打包插件

# Windows
.\deploy\start.ps1
```

### 2. 注册账号

打开 `http://localhost:8700` → 注册 → 获得 API Key（随时可在「账号」页查看/重置）。

### 3. 接入 agent 工作区

在装有 AI 编程工具的目标机器上，执行首页生成的安装命令（一条命令安装所有已支持的 agent 插件）：

```bash
# Linux / macOS
curl -fsSL http://<server>:8700/download/install.sh | bash -s -- --api-key <你的key>

# Windows (PowerShell)
& ([scriptblock]::Create((irm http://<server>:8700/download/install.ps1))) -ApiKey <你的key>
```

安装器会下载分发包并逐个执行各插件的安装子脚本（`--only opencode` / `-Only claude` 可只装指定插件）：

- **opencode**：写入 `~/.config/opencode/agent-swarm.json`（服务地址 + apikey）→ 注册 MCP 端点到 `opencode.jsonc` → 部署心跳插件 → 拷贝 `/swarm-*` 命令。**重启 opencode 后生效**
- **claude code**：`claude mcp add` 注册 remote MCP（工具）+ 本地 keepalive MCP（心跳保活）→ 拷贝 `/swarm-*` 命令到 `~/.claude/commands/`。**重启 claude 后生效**；项目里用 `/swarm-add` 注册工作区后，工作区即上线（agent_type=claude，当前不支持接收任务）

### 4. 使用

在 agent 对话里直接用 MCP 工具（`workspace_add`、`list_workspaces`、`a2a_call`…），或用 `/swarm-add` 等命令。之后：

```text
你: 调用 nas_brain 工作区，查看它最新一次 git 提交
agent: (调用 a2a_call) → 对方 TUI 实时出现任务 → 执行 → 结果自动回传
```

### 5. 中枢（Nexus）：在网页上指挥 / 围观 agent

登录后进入「中枢」页，选择一个在线工作区直接输入指令：时间线实时滚动 agent 的思考、工具调用与答复，权限请求和提问直接在页面点选应答，历史持久化保存（上滚逐轮加载更早对话）。所有指令记录在「调用记录」页（来源 `nexus-web`）。

开启**监控模式**（opencode 默认开启，TUI 内 `/swarm-monitor` 切换）后，你在 TUI 里与 agent 的日常对话也会按轮次实时同步到中枢——提问、思考、工具调用、回答全程可见，监控轮的权限请求同样可在网页远程应答。每轮对话作为 `[monitor]` 记录进入「调用记录」页。

「工作区」「调用记录」两个页面提供在线状态看板、启用/禁用、调用流水查询（按工作区筛选）等日常管理能力。

## MCP 工具一览（`/mcp/`，Bearer apikey 鉴权）

| 工具 | 说明 |
|---|---|
| `workspace_add` | 注册当前目录为工作区，返回 ID（写入项目根 `.agent_swarm/workspace.md`） |
| `workspace_remove` / `workspace_enable` / `workspace_disable` / `workspace_offline` | 工作区管理（仅离线可删） |
| `heartbeat` | 心跳保活，上报当前会话（插件每 30s 自动调用） |
| `update_info` / `update_notes` | 更新工作区用途/能力描述、备注 |
| `list_workspaces` | 列出可见工作区（默认仅在线） |
| `a2a_call` | A2A 协议任务派发：内部工作区 ID 或外部 A2A agent 端点 URL |
| `a2a_task` | 查询 A2A 任务状态与结果 |

## Docker 部署

```bash
# 一键（推荐，在项目根目录）
docker compose -f docker/compose.yaml up -d

# 或手动构建
docker build -t agent-swarm -f docker/Dockerfile .
docker run -d --name agent-swarm -p 8700:8700 \
  -v agent-swarm-data:/app/data \
  -e AGENT_SWARM_JWT_SECRET=请改成随机长字符串 \
  agent-swarm
```

单端口 `:8700` 同时服务管理前端、API、MCP 与插件分发。数据（SQLite + 插件包）持久化在 `agent-swarm-data` 卷。

## 配置

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `AGENT_SWARM_PORT` | 服务端口 | `8700` |
| `AGENT_SWARM_DB` | SQLite 路径 | `<项目根>/data/agent_swarm.db` |
| `AGENT_SWARM_JWT_SECRET` | JWT 签名密钥（**生产必设**） | dev secret |
| `AGENT_SWARM_PUBLIC_URL` | 公网地址（注入 install 脚本，反代时设） | 从请求 Host 推断 |
| `AGENT_SWARM_CALL_TIMEOUT` | 跨 agent 调用超时 | `3600`s |

环境变量优先于项目根 `.env`。

## 目录结构

```
server/            FastAPI 服务端（api/ REST、mcp_endpoint.py MCP 工具、download.py 插件分发）
plugins/opencode/  opencode 插件（TS）：心跳、任务接收执行、中枢直连；commands/ 为 /swarm-* 命令源
plugins/claude/    claude code 接入：keepalive.mjs（本地 MCP 保活 server）+ /swarm-* 命令 + 安装脚本
web/               React 管理前端（首页、文档、中枢、工作区、调用记录、账号）
deploy/            启动/停止脚本 + 安装分发器（sh + ps1）
docker/            Dockerfile + compose.yaml
docs/              补充文档
```

## 开发

```bash
./deploy/start.sh              # 服务端（改 server/ 后重启生效；同时打包 plugins/ 到 data/）
cd web && npm run dev          # 前端 dev :8701（代理 /api /mcp /download 到 8700）
cd web && npm run build        # 前端构建（产物由 8700 静态托管）
cd web && npm run lint         # oxlint
cd plugins/opencode && npm run typecheck # opencode 插件类型检查
```

> 注意：改了 `plugins/opencode/src/` 后需要重装插件并**重启 opencode** 才生效（运行中的会话持有旧代码）。
> 注意：含中文的 ps1 安装脚本必须保存为 UTF-8 **with BOM**（本地 PS 5.1 执行按 ANSI 读无 BOM 文件会乱码破坏语法）；分发器自身经 `irm | iex` 执行时由服务端以文本下发，无 BOM 要求。

## 安全说明

- MCP 与 REST 全部走鉴权（apikey / JWT）；`/download/*` 与 `/health` 除外
- SQLite 明文存 apikey 便于用户随时查看；JWT secret 生产环境务必设置
- 跨 agent 任务会注入目标工作区的 TUI 会话，请只把你信任的机器接入虫群
