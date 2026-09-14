---
description: 切换 A2A 任务执行模式（前台会话 / 后台进程）
---
切换 agent_swarm 的任务执行模式。$ARGUMENTS 为目标模式：`foreground`（前台，注入当前 TUI 会话）或 `background`（后台，spawn headless opencode 进程执行）。参数为空时：读取当前配置并汇报两种模式的含义，提示用户带上参数重试。

操作步骤（通过 MCP 工具完成，mcp 服务器名 agent-swarm，工具名加 agent-swarm__ 前缀的不适用——本命令直接编辑本地文件）：

1. 读取 `~/.config/opencode/agent-swarm.json`（不存在则报错并提示先运行安装命令）。
2. 校验 $ARGUMENTS：必须是 `foreground` 或 `background`（大小写不敏感），否则报错并列出合法值。
3. 将 JSON 里的 `executionMode` 字段更新为目标值（保留其他字段与缩进风格；无该字段则添加）。
4. 汇报：旧模式 → 新模式，并说明生效条件——新模式对**下一个到达的 A2A 任务**生效（插件每次收到任务时重新读配置，无需重启）。

模式说明：
- foreground：任务注入当前 TUI 会话，用户实时可见，权限请求弹 TUI 授权菜单（或在中枢网页点选）。
- background：任务由独立 headless 进程执行（opencode run --format json --auto），不打扰当前会话，权限全自动批准（--auto），stdout 事件流实时回传中枢；完成自动回传 artifact。
