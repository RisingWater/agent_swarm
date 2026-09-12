# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-12 · 交接给下一个 agent
> 项目路径: ~/workdir/agent_swarm · 服务已跑在 :8700 (deploy/start.sh) · 前端 dev :8701

## 项目一句话

多 agent 协作平台：FastAPI 单服务（管理 API + MCP 端点 + 插件分发）+ opencode 插件 + opencode.ai 风格纯 React 前端。用户注册后拿 apikey；面向 agent 的操作全部走服务端 MCP 工具（任何 MCP 客户端可用），opencode 插件只负责心跳保活。

## 🔥 架构转向（2026-09-12，用户决定）

- **MCP 工具是唯一面向 agent 的接口**：workspace_add/remove/enable/disable、register_workspace、workspace_whoami、heartbeat、list_workspaces 等全部在 server/mcp_endpoint.py。claude/deepseek harness 直连 /mcp 即可，可移植性优先。
- **opencode 插件已瘦身**：只做启动时 workspace_whoami 找回工作区 + 30s 心跳（被禁用时不抢回 online）。不再注入任何工具、不再领任务执行、不再 LLM 总结（summarize.ts 已删）。
- **opencode 接入方式**：install 脚本向 opencode.jsonc 写两样东西——`mcp.agent-swarm`（remote，Bearer apikey，工具直接可用）+ `plugin` file:// 项（心跳保活）。
- **/swarm 命令**：install 脚本写 ~/.config/opencode/commands/swarm.md，子命令 register/add/remove/enable/disable，全部路由到 MCP 工具。
- **求助互调（request_help/poll/submit + 插件双模式执行）暂时保留在服务端但前端流程未接**；用户明确"先做好工作区管理，互相调用后面再说"。

## 已完成（全部已提交，git log 可查）

### 服务端 (server/)
- ✅ 数据模型 users / workspaces / help_requests + **teams/team_members 表保留但功能已移除**（用户要求去掉，以后可恢复）
- ✅ 管理 REST API（JWT 24h）：注册/登录、apikey 随时可见（明文列存 db + 自动迁移老用户补发新 key）、工作区启停/删除（仅离线）、求助历史
- ✅ MCP 端点 `/mcp/`（Streamable HTTP，stateless）：**所有请求经 ApiKeyMiddleware 校验**（sha256 + 常量时间比较）
- ✅ 14 个 MCP 工具：workspace_add/remove/enable/disable/whoami、register_workspace、heartbeat、update_notes、update_info、list_workspaces、request_help、get_help_result、poll_help_requests、submit_help_result
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
