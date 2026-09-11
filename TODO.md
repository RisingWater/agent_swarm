# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-11 晚 · 交接给下一个 agent
> 项目路径: ~/workdir/agent_swarm · 服务已跑在 :8700 (deploy/start.sh) · 前端 dev :8701

## 项目一句话

多 agent 协作平台：FastAPI 单服务（管理 API + MCP 端点 + 插件分发）+ opencode 插件 + opencode.ai 风格纯 React 前端。用户注册后拿 apikey，插件把工作区注册到服务端，agent 之间可互相求助（前台/后台双模式执行）。

## 已完成（全部已提交，git log 可查）

### 服务端 (server/)
- ✅ 数据模型 users / workspaces / help_requests + **teams/team_members 表保留但功能已移除**（用户要求去掉，以后可恢复）
- ✅ 管理 REST API（JWT 24h）：注册/登录、apikey 随时可见（明文列存 db + 自动迁移老用户补发新 key）、工作区启停/删除（仅离线）、求助历史
- ✅ MCP 端点 `/mcp/`（Streamable HTTP，stateless）：**所有请求经 ApiKeyMiddleware 校验**（sha256 + 常量时间比较）
- ✅ 9 个 MCP 工具：register_workspace（返回 need_summary 标志）、heartbeat、update_notes、update_info、list_workspaces、request_help、get_help_result、poll_help_requests、submit_help_result
- ✅ 帮助请求异步闭环：pending → accepted → done/failed，结果双保险回传
- ✅ 插件分发（免鉴权）：`GET /download/plugin.tar.gz`（start.sh 打包）、`GET /download/install.sh`（**服务端从请求 Host 动态注入 server 地址**，也支持 AGENT_SWARM_PUBLIC_URL 环境变量/.env 覆盖）
- ✅ deploy/start.sh（自动建 venv、装依赖、打包插件、幂等启动）、deploy/stop.sh

### opencode 插件 (plugin/src/)
- ✅ client.ts：MCP JSON-RPC 客户端（initialize → tools/call，带 apikey）
- ✅ 注册工作区 + 30s 心跳（带 session_id）
- ✅ **LLM 惰性总结目录**：仅当服务端返回 need_summary=true 才调 LLM（走 opencode /session 接口），失败回退启发式
- ✅ 双模式任务执行：foreground = toast + appendPrompt + submitPrompt 注入当前 TUI；background（默认）= session.create + promptAsync（可指定 session_id）
- ✅ 8 个注入工具：swarm_list_workspaces / request_help / get_help_result / submit_help / note / desc / resummarize 等
- ✅ install.sh：下载 tar.gz → 装到 ~/.config/opencode/plugins/agent-swarm → 复用 opencode 依赖 → 写 config.json → 注册进 opencode.jsonc（幂等，重复安装跳过注册；逗号处理已修，含注释行场景）

### 前端 (web/)
- ✅ **已去掉 antd**（用户要求学 opencode.ai 主页），纯 React 手写
- ✅ 浅色 opencode.ai 风格：全站 IBM Plex Mono、顶部菜单导航、`[ api key ]`/`[ install ]` 方括号区块、`$` 命令终端块、状态色点、GitHub 风格 status pill
- ✅ 接入页默认打开：apikey（打码+眼睛+复制+reset 同行）、一键安装命令（自动带 origin 和 key）
- ✅ vite.config.ts 已代理 /api、/download、/mcp、/health 到 8700

### 命令（最新提交 cdb0370）
- ✅ 发现 /swarm-note 等命令需要 **~/.config/opencode/commands/*.md 文件**（不是插件注册的！插件 command.execute.before 只能拦截已有命令）
- ✅ install.sh 已加步骤 5 自动写三个命令 md 文件
- ✅ 插件加了 swarm_note / swarm_desc / swarm_resummarize 三个工具供命令模板调用
- ✅ 已验证 opencode server API /command 返回 swarm-note、swarm-desc、swarm-resummarize

## 🔴 当前卡点（接手后第一优先级）

**插件似乎没有被 opencode 加载（工具未注入）**，证据链：

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

- [ ] 工作区看板/求助记录页在新 UI 下还没实际用浏览器点过（只验证了构建），接手后过一遍
- [ ] 团队功能：models.py 保留表，前端/API 已删；用户"想好后再加"
- [ ] 前台任务的"结果兜底回传"只实现了 inflight 轮询清理，**session idle 事件监听兜底没做**（plugin/src/index.ts 里 event hook 只记录了 sessionID）
- [ ] e2e 测试脚本在 /tmp/opencode/（test_api.py、test_mcp_e2e.py、test_plugin_smoke.ts），正式的应挪进 scripts/ 并纳入 run_e2e.sh
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
