---
name: swarm-bind
description: 将当前 Codex 会话绑定为此工作区的 Agent Swarm 前台接单会话。
---

在当前 Codex 工作目录执行以下对应命令。Codex 提供的 `CODEX_THREAD_ID` 已包含当前会话 ID，直接让 worker 使用它。

```powershell
if (!$env:CODEX_HOME) { $env:CODEX_HOME = Join-Path $HOME ".codex" }
node (Join-Path $env:CODEX_HOME "agent-swarm/codex/worker.mjs") --bind-current
```

```bash
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export CODEX_HOME
node "$CODEX_HOME/agent-swarm/codex/worker.mjs" --bind-current
```

根据命令输出报告是否绑定成功。绑定成功后，保持当前会话打开，后续 Swarm 任务将投递到此会话。不要使用最近会话列表猜测 ID。
