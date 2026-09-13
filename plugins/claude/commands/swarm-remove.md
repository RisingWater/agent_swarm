---
description: 从 agent_swarm 移除当前工作区
---
从当前目录 `.agent-swarm.md` 读 WORKSPACE_ID: 行。先调用 workspace_disable 再调用 workspace_remove 移除该工作区，然后删掉文件里的 WORKSPACE_ID 行。通过 MCP 工具完成（MCP 服务器名 agent-swarm，工具全名 mcp__agent-swarm__workspace_disable / mcp__agent-swarm__workspace_remove）。工具执行结果原样汇报给用户。
