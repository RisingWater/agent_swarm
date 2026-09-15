---
description: 添加（或更新）当前工作区到 agent_swarm
---
调用 workspace_add 工具（path=当前目录绝对路径；$ARGUMENTS 非空时作为 purpose）。通过 MCP 工具完成（MCP 服务器名 agent-swarm，工具全名 mcp__agent-swarm__workspace_add）。
然后把返回的 workspace_id 写入当前目录 `.agent_swarm/workspace.md` 的 `WORKSPACE_ID:` 行（文件已存在则更新该行，不存在则新建目录 `.agent_swarm/` 与文件并加 PURPOSE:/CAPABILITIES: 占位行）。若文件里 PURPOSE:/CAPABILITIES: 为空，先分析项目补全这两行。
工具执行结果原样汇报给用户。
