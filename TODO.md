# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-13 · 交接给下一个 agent
> 项目路径: D:\wangxu\work\agent_swarm · 服务已跑在 :8700 · 前端构建产物由 8700 静态托管

## 项目一句话

多 agent 协作平台（虫群）：FastAPI 单服务（管理 API + MCP 端点 + 插件分发）+ 多 agent 插件（plugins/ 下 opencode / claude）+ 纯 React 前端。面向 agent 的操作全部走服务端 MCP 工具（任何 MCP 客户端可用），插件负责心跳保活；opencode 插件额外负责任务接收执行（前台注入优先）与中枢直连。

## 已完成（全部已提交，git log 可查）

### claude code 接入（2026-09-13 新增）

- **目录重构**：`plugin/` → `plugins/opencode/`；新增 `plugins/claude/`；安装器改造为「分发器（deploy/install.sh|.ps1）+ 各插件子脚本（install-<name>.sh|.ps1）」结构，一条命令装所有 agent（--only/-Only 可挑选）；tarball 打包整个 plugins/ 树
- **claude 接入 v1**（注册管理 + 保活）：
  - `keepalive.mjs`：零依赖本地 stdio MCP server，30s 心跳（agent_type=claude），stdin close + ppid 轮询退出 → `workspace_offline` 立即下线
  - install-claude：remote MCP + keepalive MCP 注册 + `/swarm-*` 命令 + `~/.claude/agent-swarm/config.json`
- **claude 接入 v2（channel 任务执行 + nexus + hooks）**：
  - keepalive 升级 channel：声明 `claude/channel` + `tools`（swarm_reply 1 个工具，消除 /mcp 三角警告）；心跳捎带 pending call → channel notification 注入 TUI（需 `--dangerously-load-development-channels server:agent-swarm-keepalive` 启动，否则静默丢弃任务超时）；60min 超时；退出时 abort 未完成任务
  - **swarm_reply 工具**：claude 完成后调用（call_id+result）→ workspace_call_result + timeline 收尾
  - **nexus WS**：keepalive 连 /ws/plugin（协议同 opencode 插件），网页指令秒级注入（前缀 `[来自 nexus-web 的指令]`）
  - **hooks 时间线**：`hook-timeline.mjs` 注册进 settings.json（PreToolUse/PostToolUse/Stop）→ POST /api/nexus/hook-events（新端点，apikey 鉴权，复用 _forward_event）；**state.json 门控**——keepalive 注入任务时置 active，swarm_reply 时清除，用户自己的工具调用不外泄
  - **AskUserQuestion 远程作答**：PreToolUse 上报问题选项 → 轮询 answer-<req_id>.json（keepalive 收 nexus question_reply 后写）→ allow+updatedInput 替答；5min 超时落回本地弹窗
  - 服务端：workspace_call 放开 claude 目标；`server/api/nexus.py` 新增 hook-events 端点
- **E2E 已验证**：nexus ws ready → 心跳领取 → channel 注入 injected=true → 退出 abort pending + offline，全链路 ✅；swarm_reply 会话内闭环待 claude 登录后实测
- **关键 gotcha**：含中文的 ps1（子安装脚本）必须 UTF-8 with BOM（PS 5.1 本地执行按 ANSI 读，无 BOM 时中文吃引号破坏语法，实测失败）；分发器靠 /download/install.ps1 的 utf-8-sig 剥 BOM 保持 irm|iex 兼容

### workspace_call 跨 agent 调用（核心功能，已上线并实测）

- **服务端**：`workspace_calls` 表（pending/running/done/failed，旧 help_requests 已 DROP）；4 个 MCP 工具 workspace_call / status / ack / result；heartbeat 捎带 pending 任务；REST `/api/calls` + 删除接口（仅 done/failed 可删）
- **插件前台注入**：event hook 跟踪当前会话，冷启动用 session.list 挑最近活跃会话 + tui.showToast 通知；fgBusy 排队（10min 上限）+ session.status busy 检查；无会话才退后台会话；idle 残留清理；已实测「前台可见 + 结果回传」全链路 ✅

### 服务端 (server/)

- ✅ REST：注册/登录、apikey 明文可见+重置、**修改密码**（POST /api/me/password，校验原密码）、工作区 CRUD、调用记录列表+删除
- ✅ 12 个 MCP 工具（求助类 4 个已删，workspace_call 4 个替代）
- ✅ 插件分发 /download/*（tar.gz + install.sh/ps1，Host 动态注入地址）

### opencode 插件 (plugins/opencode/)

- ✅ 心跳 + 任务执行全链路（见上）；已重装部署到 ~/.config/opencode/plugins/agent-swarm/

### 前端 (web/) —— 已打磨

- ✅ **虫群品牌**：favicon/logo（六椭圆个体环绕 AI 核，黑白）+ logo-48/128/512/1024.png（Pillow 生成）
- ✅ **首页**：左对齐 hero → 马上安装（登录/未登录两种态；**agent 工具图标组**：opencode + claude code 已支持高亮，deepseek harness/pi/更多 灰显待支持）→ **演示视频**（agent_swarm.mp4，39MB，进视口自动静音播放一次、停末帧、无控件、右下角声音切换）→ 什么是 agent_swarm（4 特性卡黑白线性图标）→ 它可以做什么 → 阅读文档 CTA
- ✅ **登录弹窗化**：未登录可见 首页/文档；工作区、调用记录、账号菜单隐藏；"登录/注册"弹覆盖弹窗
- ✅ **账号页**（点用户名进入）：左侧二级菜单 API Key | 修改密码，右侧内容
- ✅ **文档页**：左目录右内容滚动定位，6 章（介绍/安装插件/注册工作区/核心概念/MCP 工具/FAQ）——纯用户视角，无服务器部署内容；安装章节已覆盖 opencode + claude 双插件
- ✅ 工作区/调用记录页：中文表头、搜索框、时间列完整日期、markdown 渲染结果弹窗（react-markdown+remark-gfm）、垃圾桶删除；工作区离线时间改为 hover tip（online 不显示）
- ✅ 中枢页：上次选中工作区记 cookie（30 天），下次打开自动回填

### 中枢 nexus

- ✅ **服务端**：`server/nexus.py` WebSocket hub（`/ws/nexus`，JWT 鉴权）；订阅工作区时间线 + 下发指令；`nexus_events` 表持久化；指令落调用记录，来源标注 `nexus-web`
- ✅ **插件**：`plugins/opencode/src/nexus.ts` —— 接收网页指令、回传会话事件流
- ✅ **前端**：「中枢」页——选在线工作区下发指令，时间线实时滚动；权限请求/提问直接在页面点选应答；终端风格 UI
- ✅ 文档同步：README「中枢」章节 + 首页特性 + 文档页 web-admin 小节

### 基建

- ✅ docker/（Dockerfile 多阶段）——**未实测，用户计划下周一在公司验证**
- ✅ README.md（架构图、快速开始、MCP 工具表、Docker 部署、配置表、开发指南）
- ✅ AGENTS.md 刷新（plugins/ 结构、安装器结构、claude keepalive 生命周期、ps1 BOM gotcha）

## 🟡 未完成 / 待办

### 高优先级

- [ ] **Docker 构建实测**（用户下周一去公司测试）：Dockerfile/compose.yaml 已写好但未跑过，首次 build 可能在 npm ci（alpine 平台二进制）出问题，待验证；注意 Dockerfile 里 plugin 打包路径若引用 `plugin/` 需同步改成 `plugins/`
- [ ] **claude v2 E2E 待补**：keepalive 侧全链路已验证（心跳领取 → channel 注入 injected=true → 退出 abort + offline），但 claude CLI 未登录导致 swarm_reply 闭环（claude 会话内调工具回传结果）待登录后实测；AskUserQuestion 远程作答同理
- [ ] claude 权限中继（Bash/Write 远程 approve，走 claude/channel/permission）——用户确认要做，v3

### 备忘

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
