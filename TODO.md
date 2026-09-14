# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-14 晚（Linux 机，wangxu 回家前交接）
> 本机路径: /home/wangxu/workdir/agent_swarm · 服务已跑在 :8700（日志 /tmp/opencode/swarm-start.log）· 前端构建产物由 8700 静态托管
> 全部代码已提交并推送 origin/dev（HEAD = c345e3b）

## 项目一句话

多 agent 协作平台（虫群）：FastAPI 单服务（管理 API + MCP 端点 + A2A 网关 + 插件分发）+ 多 agent 插件（plugins/ 下 opencode / claude）+ 纯 React 前端。面向 agent 的操作全部走服务端 MCP 工具；工作区互调 / web 中枢 / 外部 agent 统一走 A2A 协议（`server/nexus_a2a.py` 手写子集）；插件负责心跳保活 + A2A 任务接收执行。

## 今天（2026-09-14）已完成并推送

### /swarm-* 命令：TUI 化 + /swarm-add 回退 md 命令（最终形态）

- **TUI 插件 `plugins/opencode/src/tui.ts`**（注册于 `~/.config/opencode/tui.jsonc`，**不是** opencode.jsonc——TUI 插件必须注册在 tui.jsonc，这是踩过的坑）：
  - `/swarm-mode`（DialogSelect 切前台/后台）、`/swarm-remove`、`/swarm-enable`、`/swarm-disable` 四个命令，全部静默执行 + toast 反馈（用户决策：只有 mode 弹窗）
  - **`/swarm-add` 不在 tui.ts 里**——回退为 md 命令 `plugins/opencode/commands/swarm-add.md`（见下）
  - 其余 md 命令（swarm-register/note/desc 等）已在安装脚本里清理
- **`/swarm-add` md 命令**（headless 总结方案被否，回退 master 时代思路）：
  - 前台会话由 agent 自己分析项目生成 PURPOSE/CAPABILITIES（各≤80字），调 MCP `workspace_add`，`need_summary=true` 时用 `update_info` 回写，再把 WORKSPACE_ID/PURPOSE/CAPABILITIES 写进 `.agent-swarm.md`（模板：`# agent_swarm` + 三行）
  - **被否方案勿重试**：spawn headless opencode 生成 purpose——① 挂 `--session 当前会话` 会把对话上下文带进总结，上传过屁话；② 新会话方案会话数量膨胀、复杂度高（专属 summarySessionId 方案写了又删）
  - 已实测走通：本仓库 purpose/capabilities 已用干净总结覆盖（DB + 文件一致）
- **服务端**：`POST /api/workspaces`（create_workspace）新增，`purpose`/`capabilities` 字段支持；`server/auth.py` 加 `get_user_either`（JWT 优先、apikey 兜底）——TUI 插件只有 apikey，REST 端点 create/disable/enable/delete 都用它
- **安装脚本** `install-opencode.sh|.ps1`：index.ts→opencode.jsonc、tui.ts→tui.jsonc 分开注册；复制 swarm-add.md 到 ~/.config/opencode/commands/；清理列表不含 swarm-add
- 用户本机 apikey 曾出现尾部多 `~` 的脏数据（~/.config/opencode/agent-swarm.json），已修；来源未知，见 到此值不对先查这里

### 后台执行模式（A2A 任务）

- `plugins/opencode/src/background.ts`：spawn `opencode run --format json --auto --title A2A-<id>` headless 进程，stdout 事件流归一化为 A2A 事件（text/tool），exit+finalText 决定 completed/failed；30min 超时 kill 进程树、并发上限 3、cancel 支持
- `config.ts` `executionMode`：foreground / background；**`/swarm-mode` 切换即时生效**（executeTask 每任务 loadConfig() 重读，勿退回启动时闭包快照）
- **config 合并优先级已修**：全局 `~/.config/opencode/agent-swarm.json` 显式设置时优先，否则插件目录 config.json（老逻辑"任一为 background 就 background"，导致全局切不回 foreground）
- ⚠️ **改了 executionMode 后需重启 opencode 才完全生效**（重读逻辑在任务分发处，但插件重载配置依赖的是新代码；本机已同步新代码并重启过一次）

## 🟡 未完成 / 待办（接手从这里开始）

### 高优先级

- [ ] **后台会话还没调通（最重要）**。症状：web 下发任务选了 background，任务文本仍出现在前台 TUI 会话。已修两轮（每任务重读配置 c345e3b 之前；去掉服务端会话锚点 resume=c345e3b，后台一律新开会话），**但用户重启 opencode 后还没做过 E2E 验证**。验证方法：
  1. 重启 opencode（用户手动）
  2. web 中枢对该工作区发任务
  3. 看前台 TUI 是否出现任务文本（不应出现）
  4. `tail -f ~/.config/opencode/plugins/agent-swarm/plugin.log` 应见 `background mode (new session)` 且**无** `resume ses_` 字样；web 中枢应看到 A2A-xxxx 标题的独立会话执行流
  5. 若仍进前台：查 plugin.log 里该任务走的是 `background mode` 还是前台路径日志格式 `session ses_xxx`；再查 tui.jsonc/opencode.jsonc 里插件是否最新（文件 mtime）
- [ ] **前端 web 的 A2A 页面与后台会话展示未更新**：后台任务的独立会话（A2A-xxx）在前端中枢页没有专门的展示/区分；task 的 session_id 上报后工作区表"当前会话"列是否正确刷新未验证；A2A 事件流里后台事件（metadata.background=true）前端未特殊渲染。用户原话："前端的a2a和后台会话还没有更新"
- [ ] **claude 后台会话未做**：claude 侧后台任务执行（用户提到"前台会话做不了"——claude 工作区目前只注册/保活，A2A 网关服务端直接拒绝执行；需要给 claude 做 headless 执行通道，方向参考 opencode 的 background.ts，claude 对应 `claude -p --output-format stream-json` headless 流式）。用户决策记录：claude 只做后台，不做前台注入
- [ ] 真实 opencode 前台注入 E2E：web 下发 → TUI 前台注入 → 权限应答 → artifact 回传 全链路（前台路径今天只验了任务文本能进来，权限/提问/input-required 流程未验）

### 备忘

- [ ] a2a-inspector 互操作验证（可选）
- [ ] nas_brain 工作区 ID：XYaR4TdtGqdqoAEW9vNn8g（旧的 nDZDDucfudwSPmN5Nec3GU 已失效）
- [ ] DB 里可能残留脏 purpose 的工作区（今天上午 headless 方案上传过对话屁话，已修 agent_swarm 本仓库那条；其他机器工作区如有同类问题用 update_info 覆盖）

## 环境/常用操作（Linux 本机）

```bash
./deploy/start.sh            # 服务 :8700（幂等；日志 /tmp/opencode/swarm-start.log）
./deploy/stop.sh
cd web && npm run build      # 产物由 8700 托管，无需重启服务
cd web && npm run dev        # dev :8701
cd plugins/opencode && ./node_modules/.bin/tsc --noEmit   # typecheck
# 改了 plugins/opencode/src/ 后本机生效：
cp src/xxx.ts ~/.config/opencode/plugins/agent-swarm/src/  # 同步
tar -czf data/agent-swarm-plugin.tar.gz -C . --exclude=node_modules --exclude=types --exclude='*.tsbuildinfo' plugins  # 重打包
# 然后重启 opencode（必须，运行中的会话持有旧插件代码）
```

- 用户 apikey（两处应一致）：`~/.config/opencode/agent-swarm.json`（全局，TUI 插件读这个）与 `~/.config/opencode/plugins/agent-swarm/config.json`（server 插件兜底）。当前值 as_4wq5J2YGkdNXRymv_x4gCMTpoFHXbM0WS5UidSDEkyE
- 插件日志：`~/.config/opencode/plugins/agent-swarm/plugin.log`（server 插件与 TUI 插件共用；TUI 行带 `[tui]` 前缀——目前 tui.ts 已无 [tui] 日志调用，保留机制）
- opencode 运行日志：`~/.local/share/opencode/log/opencode.log`（TUI 插件加载报错看这里）
- 心跳 30s，90s 超时判离线；**时间戳全是 UTC**，用户在 UTC+8，别拿本地时钟肉眼对比心跳新鲜度（AGENTS.md 有记载，反复踩过）
- JWT_SECRET 未设（dev 默认），生产前要改
- ⚠️ 改 plugins/opencode/src/ 后：同步安装目录 + 重打 tarball + 重启 opencode 才生效
- ⚠️ 含中文的 ps1 安装脚本必须 UTF-8 with BOM
- 验证后台模式是否走对的快捷方法：`grep "background\|a2a" ~/.config/opencode/plugins/agent-swarm/plugin.log | tail`
