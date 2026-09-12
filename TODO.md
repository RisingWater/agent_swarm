# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-12 · 交接给下一个 agent
> 项目路径: ~/workdir/agent_swarm · 服务已跑在 :8700 (deploy/start.sh) · 前端 dev :8701

## 项目一句话

多 agent 协作平台：FastAPI 单服务（管理 API + MCP 端点 + 插件分发）+ opencode 插件 + opencode.ai 风格纯 React 前端。用户注册后拿 apikey；面向 agent 的操作全部走服务端 MCP 工具（任何 MCP 客户端可用），opencode 插件负责心跳保活与任务接收执行。

## 架构决定（2026-09-12，用户拍板，仍然有效）

- **MCP 工具是唯一面向 agent 的接口**：workspace_add/remove/enable/disable、list_workspaces 等全部在 server/mcp_endpoint.py。claude/deepseek harness 直连 /mcp 即可，可移植性优先。之前的 register_workspace / workspace_whoami 已删（workspace_add 一个工具覆盖，ID 落在 .agent-swarm.md）。
- **工作区 ID 持久化在项目根 .agent-swarm.md 的 WORKSPACE_ID: 行**：workspace_add 返回 ID → agent 写文件；插件启动直接读文件拿 ID 心跳，每轮重读（换 ID 免重启）。
- **opencode 插件已瘦身**：只做读 ID + 30s 心跳（日志写 plugin.log，不进 TUI）。任务执行能力将随 workspace_call 阶段回归插件。
- **opencode 接入方式**：install 脚本向 opencode.jsonc 写两样东西——`mcp.agent-swarm`（remote，Bearer apikey，工具直接可用）+ `plugin` file:// 项（心跳保活）。
- **命令**：install 脚本从插件包 commands/ 目录拷贝 5 个独立命令 /swarm-add /swarm-register /swarm-remove /swarm-enable /swarm-disable（opencode 文档推荐独立命令而非子命令解析）。
- 旧的 request_help/poll/submit 同步异步双模式设计**先放一边**，workspace_call 阶段重新设计（用户 2026-09-12 明确）。

**前置工作区管理已收尾**（MCP-first 架构，见下）。workspace_call 已实现（2026-09-12）：

- **服务端**：新表 `workspace_calls`（pending/running/done/failed，旧 help_requests 表已 DROP 删除）；4 个 MCP 工具 `workspace_call`（允许调用自身工作区，方便单机测试）/ `workspace_call_status`（调用方轮询，超时兜底 AGENT_SWARM_CALL_TIMEOUT 默认 1h）/ `workspace_call_ack` / `workspace_call_result`（插件专用）；**heartbeat 响应捎带 pending 任务**（`calls` 字段），无需独立轮询通道；REST `/api/calls`（web 调用记录页数据源）
- **插件**：心跳拿到 calls → 并发上限 2（满载跳过，下轮心跳重新领取）→ ack → **前台注入优先**：目标 = event hook 跟踪的当前会话（冷启动没事件时 `session.list` 挑最近活跃会话 + `tui.showToast` 弹通知）；前台被占（fgBusy）或目标会话 busy（`session.status`）则排队等（上限 10 分钟，超时/无任何会话才退回 `client.session.create` 后台会话，标题 `Swarm-call-<id8>`）→ `promptAsync` 注入 → event hook 收 `session.idle` + 2s 轮询兜底 → 末尾停在 tool 调用则发 synthetic nudge（≤2 次）→ 提取最后 assistant 文本回传
- **权限策略**：任务会话触发 permission.asked 时由**目标工作区用户在 TUI 响应**（方案 1，用户拍板）；中继回调用方列为二期
- 旧的 request_help/poll/submit 同步异步双模式设计**已整体删除**（用户 2026-09-12 明确）

### ⚠️ 下一步（接手第一件事）

1. **重启本机 opencode**（当前会话还载着旧版插件，收不到任务），pending 任务 `Wmdzw2A98dEcaVQ7pq4Hzx`（问 1+1）应被自动领取执行
2. 验证脚本 `C:\Users\wangxu\AppData\Local\Temp\opencode\e2e_call2.ps1`（workspace_call → 轮询 status 至 done）
3. 观察点：plugin.log 的 ack/executing/done 日志、TUI 会话列表出现 `Swarm-call-*`、`workspace_call_status` 变 done
4. 旧 `scripts/test_plugin_smoke.ts` 引用已删的 client API，需要重写为纯 MCP 调用

### opencode-feishu 调研结论（2026-09-12，修正版）

- promptAsync 的会话是普通顶层 session，**TUI 会话列表可见、可切换围观实时执行**；插件不自动切换 TUI 视图（用户说"能看到消息"就是这个）
- 完成判定 = 轮询 `session.messages()`（baseline 对比）+ SSE `session.idle`；工具调用卡住用 synthetic prompt nudge 救
- 权限/问答交互闭环参考其 commit bb01ae5（卡片点击 → reply 回写 → 卡片替换防重）

## 已完成（全部已提交，git log 可查）

### 服务端 (server/)
- ✅ 数据模型 users / workspaces / help_requests + **teams/team_members 表保留但功能已移除**（用户要求去掉，以后可恢复）
- ✅ 管理 REST API（JWT 24h）：注册/登录、apikey 随时可见（明文列存 db + 自动迁移老用户补发新 key）、工作区启停/删除（仅离线）、求助历史
- ✅ MCP 端点 `/mcp/`（Streamable HTTP，stateless）：**所有请求经 ApiKeyMiddleware 校验**（sha256 + 常量时间比较）
- ✅ 12 个 MCP 工具：workspace_add/remove/enable/disable、heartbeat、update_notes、update_info、list_workspaces + 求助类 request_help、get_help_result、poll_help_requests、submit_help_result（求助类将随 workspace_call 阶段重构）
- ✅ 帮助请求异步闭环：pending → accepted → done/failed（服务端侧完成，客户端派发搁置）
- ✅ 插件分发（免鉴权）：`GET /download/plugin.tar.gz`（start.sh 打包）、`GET /download/install.sh`（**服务端从请求 Host 动态注入 server 地址**，也支持 AGENT_SWARM_PUBLIC_URL 环境变量/.env 覆盖）
- ✅ deploy/start.sh / start.ps1（自动建 venv、装依赖、打包插件、幂等启动）

### opencode 插件 (plugin/src/)
- ✅ **已瘦身**（2026-09-12）：index.ts 只剩 whoami 找回 + 心跳循环 + session 跟踪 + dispose；client.ts 只剩 callTool/whoami/heartbeat；summarize.ts 已删除
- ✅ typecheck 通过；install.ps1 已写 mcp.agent-swarm 到 opencode.jsonc 并实测 tools/list 返回 14 个工具

### 前端 (web/)
- ✅ **已去掉 antd**（用户要求学 opencode.ai 主页），纯 React 手写
- ✅ 浅色 opencode.ai 风格：全站 IBM Plex Mono、顶部菜单导航、`[ api key ]`/`[ install ]` 方括号区块、`$` 命令终端块、状态色点、GitHub 风格 status pill
- ✅ 接入页默认打开：apikey（打码+眼睛+复制+reset 同行）、一键安装命令（自动带 origin 和 key）
- ✅ vite.config.ts 已代理 /api、/download、/mcp、/health 到 8700

### 命令
- ✅ /swarm.md 子命令路由（register/add/remove/enable/disable），install 脚本自动写并清理旧版 swarm-register.md 等

## ~~🔴 当前卡点：插件不加载~~（已解决 2026-09-12）

**结论：插件其实一直在正常加载**。当年"工具未注入"是误判——旧版插件的工具只有在调用时才暴露，且日志里那两条 ERROR 经 GBK 解码后是 `agent_swarm: 已重新总结目录用途 ✓`（旧版用 throw 传结果的显示方式），不是加载失败。现在工具全部改走 mcp.agent-swarm（opencode.jsonc），与插件加载与否解耦，本会话已实测 MCP 工具可用。以下排查记录仅存档：

1. `opencode run "请调用 swarm_resummarize 工具"` → LLM 回复"当前工具集中没有该工具"
2. `/experimental/tool/ids?directory=...` 返回 14 个工具，**无任何 swarm 工具**
3. 日志里 nyro_token_plugin 报错（它是 dist/tui.js，报 must default export an object with server()），但 **agent-swarm 完全静默** —— 连加载日志都没有，疑似根本没被加载
4. opencode.jsonc 里注册的是 `file://~/.config/opencode/plugins/agent-swarm/src/index.ts`（**.ts 源文件**）

### 排查方向（按优先级）

1. **学 opencode-feishu 怎么做的**（用户明确要求参考它，路径 `/mnt/disk_nvme1/workdir/opencode-feishu/`）：
   - 它用 **tsup 打包成 dist/index.js**，package.json main/exports 指向 dist
   - 它在 opencode.jsonc 里注册过目录形式（`"/mnt/disk_nvme1/workdir/opencode-feishu"` 被注释掉的那行）和 file:// 形式
   - **可能根因：opencode 对 .ts 源文件插件支持不好，或需要 package.json 的 main/exports 入口**。我们注册的是裸 index.ts 且 package.json 的 main 指向 src/index.ts
   - 建议：装 tsup 把插件打包成 dist/index.js，注册 `file://.../dist/index.js`，或注册目录形式
2. 查 opencode 插件加载日志格式（grep "failed to load plugin" 的出处，看 agent-swarm 为何静默）
3. 检查 plugin default export 签名：feishu 报错信息说 "must default export an object with **server()**" —— 注意插件可能需要 `PluginModule = { id?, server: Plugin, tui? }` 形式（见 @opencode-ai/plugin/dist/index.d.ts 里 `export type PluginModule`），而我们直接 export 了一个 Plugin 函数。**但 nyro_token_plugin 也是直接函数形式且报了这个错** —— 仔细读 plugin/dist/index.d.ts 确认 1.18.30 版本的正确导出格式
4. node strip-types 跑不了（无扩展名 import），但 opencode 是 bun 内核应该可以 —— 不过要实测确认
5. 注意：插件加载后 `register()` 是 fire-and-forget，如果 client 初始化抛错只会 console.log —— 把日志级别调 DEBUG 看

### 快速验证命令

```bash
# 服务健康
curl localhost:8700/health
# 看插件是否注册进配置
grep -A4 '"plugin"' ~/.config/opencode/opencode.jsonc
# 跑 opencode 看插件加载日志
cd ~/workdir/agent_swarm && opencode run "reply ok" --print-logs 2>&1 | grep -iE "plugin|swarm"
# 查工具列表（serve 模式）
opencode serve --port 8799 &  # 然后查 /experimental/tool/ids?directory=<abs path>
```

## 🟡 次要 TODO

- [ ] **求助互调暂缓**：request_help/get_help_result/poll/submit 仍在服务端，但插件双模式执行已删；恢复时把派发逻辑做成服务端任务队列或独立 worker，别再塞回插件
- [ ] 工作区看板/求助记录页在新 UI 下还没实际用浏览器点过（只验证了构建），接手后过一遍
- [ ] 团队功能：models.py 保留表，前端/API 已删；用户"想好后再加"
- [ ] e2e 测试脚本在 /tmp/opencode/（test_api.py、test_mcp_e2e.py、test_plugin_smoke.ts），正式的应挪进 scripts/ 并纳入 run_e2e.sh（注意 test_plugin_smoke.ts 用的旧版插件工具已删，需要重写为纯 MCP 调用）
- [ ] npm install 依赖安装较慢（~40s），考虑像 opencode-feishu 一样把 @opencode-ai/* 设为 peerDependencies
- [ ] README.md 还没写

## 环境/常用操作

```bash
# 重启服务（自动打包插件）
./deploy/start.sh        # 已在跑则幂等退出；先 ./deploy/stop.sh
# 前端 dev server
cd web && npx vite --port 8701   # 已在跑
# 跑后端测试
.venv/bin/python /tmp/opencode/test_mcp_e2e.py
# 本机重装插件
curl -fsSL localhost:8700/download/install.sh | bash -s -- --api-key <key>
```

用户 wangxu 的 apikey 在 ~/.config/opencode/plugins/agent-swarm/config.json。
服务端 JWT_SECRET 未设环境变量（用默认 dev secret），生产部署前要改。
