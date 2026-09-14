# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-14 · 交接给下一个 agent
> 项目路径: D:\wangxu\work\agent_swarm · 服务已跑在 :8700 · 前端构建产物由 8700 静态托管

## 项目一句话

多 agent 协作平台（虫群）：FastAPI 单服务（管理 API + MCP 端点 + 插件分发）+ opencode 插件 + 纯 React 前端。面向 agent 的操作全部走服务端 MCP 工具（任何 MCP 客户端可用），opencode 插件负责心跳保活与任务接收执行（前台注入优先）。

## 已完成（全部已提交，git log 可查）

### workspace_call 跨 agent 调用（核心功能，已上线并实测）

- **服务端**：`workspace_calls` 表（pending/running/done/failed，旧 help_requests 已 DROP）；4 个 MCP 工具 workspace_call / status / ack / result；heartbeat 捎带 pending 任务；REST `/api/calls` + 删除接口（仅 done/failed 可删）
- **插件前台注入**：event hook 跟踪当前会话，冷启动用 session.list 挑最近活跃会话 + tui.showToast 通知；fgBusy 排队（10min 上限）+ session.status busy 检查；无会话才退后台会话；idle 残留清理；已实测「前台可见 + 结果回传」全链路 ✅

### 服务端 (server/)

- ✅ REST：注册/登录、apikey 明文可见+重置、**修改密码**（POST /api/me/password，校验原密码）、工作区 CRUD、调用记录列表+删除
- ✅ 12 个 MCP 工具（求助类 4 个已删，workspace_call 4 个替代）
- ✅ 插件分发 /download/*（tar.gz + install.sh/ps1，Host 动态注入地址）

### opencode 插件 (plugin/)

- ✅ 心跳 + 任务执行全链路（见上）；已重装部署到 ~/.config/opencode/plugins/agent-swarm/

### 前端 (web/) —— 本轮重点打磨

- ✅ **虫群品牌**：favicon/logo（六椭圆个体环绕 AI 核，黑白）+ logo-48/128/512/1024.png（Pillow 生成）
- ✅ **首页**：左对齐 hero → 马上安装（登录/未登录两种态，未登录命令显示"你的apikey"占位 + 注册/登录链接弹登录弹窗；**agent 工具图标组**：opencode 已支持高亮，claude code/deepseek harness/pi/更多 用官方 SVG logo 灰显待支持）→ **演示视频**（agent_swarm.mp4，39MB，进视口自动静音播放一次、停末帧、无控件、右下角声音切换）→ 什么是 agent_swarm（4 特性卡黑白线性图标）→ 它可以做什么 → 阅读文档 CTA
- ✅ **登录弹窗化**：未登录可见 首页/文档；工作区、调用记录、账号菜单隐藏；"登录/注册"弹覆盖弹窗
- ✅ **账号页**（点用户名进入）：左侧二级菜单 API Key | 修改密码，右侧内容
- ✅ **文档页**：左目录右内容滚动定位，6 章（介绍/安装插件/注册工作区/核心概念/MCP 工具/FAQ）——纯用户视角，无服务器部署内容；"支持哪些 AI 工具"表述已对齐：目标是所有 MCP 客户端，目前支持 opencode，逐步扩展
- ✅ 工作区/调用记录页：中文表头、搜索框、时间列完整日期、markdown 渲染结果弹窗（react-markdown+remark-gfm）、垃圾桶删除
- ✅ switch on 色改黑、状态 pill、Invalid Date 修复（fmtTime 安全解析）

### 基建

- ✅ docker/（Dockerfile 多阶段：node 构建前端 → python 运行时；compose.yaml；.dockerignore；deploy/build_docker.sh）——**已实测构建通过**
- ✅ README.md（架构图、快速开始、MCP 工具表、Docker 部署、配置表、开发指南）
- ✅ AGENTS.md 刷新（12 工具清单、任务派发机制、前端坑，与 README 去重：产品文档归 README/文档页，AGENTS 只放架构决策与 gotcha）

### 中枢 nexus（2026-09-12/13 新增，已提交）

- ✅ **服务端**：`server/nexus.py` WebSocket hub（`/ws/nexus`，JWT 鉴权）；订阅工作区时间线 + 下发指令；`nexus_events` 表持久化（models.py，自增 id 即时间序）；指令落调用记录，来源标注 `nexus-web`（预留 nexus-feishu/wechat 等扩展）
- ✅ **插件**：`plugin/src/nexus.ts`（239 行）——接收网页指令、回传会话事件流（user/text/reasoning/tool/permission/question/idle/error）
- ✅ **前端**：「中枢」页——选在线工作区下发指令，时间线实时滚动；权限请求/提问直接在页面点选应答（permission_reply）；终端风格 UI（tui 主题）
- ✅ 文档同步：README「中枢」章节 + 首页特性 + 文档页 web-admin 小节

## 🟡 未完成 / 待办

### 高优先级

- [x] **Docker 构建实测**（2026-09-14 ✅）：`./deploy/build_docker.sh` 构建成功（agent-swarm:latest，286MB，已推私有仓库 10.17.17.19:8082/agent-swarm）。踩坑记录：镜像内置旧 pip（25.0.1）在 fastapi/pydantic/starlette 交叉约束上 resolver 回溯死循环 → Dockerfile 已修（装依赖前先 upgrade pip）。本地 8700 被 dev 服务占用，docker 起之前先 ./deploy/stop.sh 或换端口映射
- [ ] nas_brain 工作区重新注册后 ID 变了（XYaR4TdtGqdqoAEW9vNn8g），注意旧的 nDZDDucfudwSPmN5Nec3GU 已失效

## 环境/常用操作

```powershell
# 重启服务（Windows；自动构建前端 + 打包插件）
.\deploy\start.ps1          # 已在跑则幂等退出；先 .\deploy\stop.ps1
# 前端
cd web && npm run build     # 产物由 8700 托管，无需重启服务
cd web && npm run dev       # dev :8701
cd plugin && npm run typecheck
# 本机重装插件（改了 plugin/src/ 后必须 + 重启 opencode）
# 用 web 首页生成的安装命令
```

- 用户 wangxu 的 apikey 在 ~/.config/opencode/plugins/agent-swarm/config.json
- 服务端跑法：Start-Process uvicorn（当前手工起的后台进程）或 .\deploy\start.ps1
- JWT_SECRET 未设环境变量（用默认 dev secret），生产部署前要改
- ⚠️ 改 plugin/src/ 后：重装插件 + 重启所有 opencode 会话才生效
