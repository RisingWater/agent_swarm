---
description: 分析项目并注册到 agent_swarm（生成总结后 add）
---
分析当前项目：读 README、配置文件、目录结构，先写好当前目录 `.agent-swarm.md`（含 PURPOSE:/CAPABILITIES: 两行，各不超 80 字，可加简短结构说明）。
然后调用 workspace_add 工具（path=当前目录绝对路径，purpose/capabilities 取自文件），并把返回的 workspace_id 写入该文件的 WORKSPACE_ID: 行。通过 MCP 工具完成（mcp 服务器名 agent-swarm，工具名加 agent-swarm__ 前缀）。
工具执行结果原样汇报给用户。
