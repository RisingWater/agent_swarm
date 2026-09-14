# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-14 · 交接给下一个 agent
> 项目路径: D:\wangxu\work\agent_swarm · 服务已跑在 :8700 · 前端构建产物由 8700 静态托管

## 项目一句话

多 agent 协作平台（虫群）：FastAPI 单服务（管理 API + MCP 端点 + A2A 网关 + 插件分发）+ 多 agent 插件（plugins/ 下 opencode / claude）+ 纯 React 前端。面向 agent 的操作全部走服务端 MCP 工具；工作区互调 / web 中枢 / 外部 agent 统一走 A2A 协议（`server/nexus_a2a.py` 手写子集）；插件负责心跳保活 + A2A 任务接收执行。

## 已完成（全部已提交，git log 可查）

### A2A 协议改造（2026-09-14，替换 nexus 自定义协议 + workspace_call）

- **服务端 `server/nexus_a2a.py`**（手写 A2A 0.3.x 子集，无官方 SDK）：
  - HTTP 入站：`GET /.well-known/agent-card.json`（中枢卡）+ `GET/POST /a2a/{workspace_id}`（工作区卡 + `message/send`、`message/stream` SSE、`tasks/get`、`tasks/cancel`），apikey 鉴权，对象 camelCase 规范形状
  - WS 内部链路：`/ws/plugin`（rpc 下发/应答 + event 流）、`/ws/nexus`（web 订阅）；离线任务 hello 时补推（不再靠 heartbeat 捎带）
  - 进程内事件总线 `_task_queues`：SSE / 同步等待纯推送无轮询；事件落 `a2a_events`（web 回放上限 800）
  - REST：`POST /api/nexus/{wid}/message:send`（web 下发）、`POST /api/nexus/{wid}/reply`（input-required 应答，转 DataPart 续聊）、`GET/DELETE /api/nexus/{wid}/history`
- **MCP 工具 13→11**：删 workspace_call/status/ack/result，新增 `a2a_call`（工作区 ID 或外部 URL）+ `a2a_task`；外部任务落同一张 `a2a_tasks` 表（external_url 标记）
- **插件**：`nexus_a2a.ts`（JSON-RPC 分发 + A2A 事件构造）+ `index.ts` `executeTask`：opencode SSE → `metadata.nexus`（text/reasoning/tool）事件、权限/提问 → `input-required` DataPart、idle → artifact（全量文本 lastChunk）+ completed；input-required 应答走 `onReply` 路由回 opencode API
- **心跳增强**：heartbeat 新增 `session_title` 参数（workspaces 表加列，db.py 自动迁移），插件会话变化时拉一次标题随心跳上报
- **web**：中枢页改 A2A 事件渲染（WS 载荷直转 TimelineItem，taskId 随权限/提问条目存储供应答）；调用记录页状态对齐 TaskState（queued/working/completed/failed/canceled）
- **E2E 已实测**（Linux，:8700）：a2a_call 互调全链路（rpc 下发→事件流→artifact→completed→a2a_task 轮询到结果）、外部 message/send 入站、message/stream SSE（快照→流式进度→artifact→final）、web 中枢 WS 订阅+REST 下发+清空历史，全部通过

### claude code 接入（2026-09-13）

- `plugins/claude/keepalive.mjs` 零依赖 stdio MCP 保活 + install-claude 脚本 + `/swarm-*` 命令；claude 工作区仅注册/保活，A2A 网关侧拒绝执行
- 含中文 ps1 必须 UTF-8 with BOM（详见 AGENTS.md）

### 服务端 / 前端 / 基建（此前已有）

- ✅ REST：注册/登录、apikey 明文可见+重置、修改密码、工作区 CRUD、调用记录列表+删除（状态已对齐 A2A TaskState）
- ✅ 11 个 MCP 工具（见上）；插件分发 /download/*
- ✅ 前端：品牌/首页/登录弹窗化/账号页/文档页/工作区/调用记录/中枢（cookie 记忆选中工作区）
- ✅ docker/ 已实测构建通过（agent-swarm:latest 286MB，已推 10.17.17.19:8082）

## 🟡 未完成 / 待办

### 高优先级

- [ ] **插件重装 + opencode 重启**（本机）：A2A 改造改了 plugins/opencode/src/，必须走 web 首页安装命令重装并重启所有 opencode 会话才生效（plugin.log 可验证版本）
- [ ] 真实 opencode 会话 E2E：上面的 E2E 是 fake plugin（websockets 模拟），需用真实插件跑一轮「web 中枢下发 → TUI 前台注入 → 权限应答 → artifact 回传」
- [ ] claude 接入 v2：任务执行 / A2A 通道接入（用户在研究 headless stream-json、hooks、channel API 等方案）

### 备忘

- [ ] a2a-inspector 互操作验证（规范符合性快检，可选）
- [ ] nas_brain 工作区重新注册后 ID 变了（XYaR4TdtGqdqoAEW9vNn8g），注意旧的 nDZDDucfudwSPmN5Nec3GU 已失效

## 环境/常用操作

```powershell
# 重启服务（Windows；自动构建前端 + 打包插件）
.\deploy\start.ps1          # 已在跑则幂等退出；先 .\deploy\stop.ps1
# 前端
cd web && npm run build     # 产物由 8700 托管，无需重启服务
cd web && npm run dev       # dev :8701
cd plugins/opencode && npm run typecheck
# 本机重装插件（改了 plugins/opencode/src/ 后必须 + 重启 opencode）
# 用 web 首页生成的安装命令（一条命令装 opencode + claude）
```

- 用户 wangxu 的 apikey 在 ~/.config/opencode/plugins/agent-swarm/config.json（claude 侧在 ~/.claude/agent-swarm/config.json）
- 服务端跑法：Start-Process uvicorn（当前手工起的后台进程）或 .\deploy\start.ps1
- JWT_SECRET 未设环境变量（用默认 dev secret），生产部署前要改
- ⚠️ 改 plugins/opencode/src/ 后：重装插件 + 重启所有 opencode 会话才生效
- ⚠️ 含中文的 ps1 安装脚本必须 UTF-8 with BOM（详见 AGENTS.md）
