# AGENTS.md

Multi-agent collaboration hub: agents register their opencode workspaces to a central server and ask each other for help. Single FastAPI service (`server/`) that hosts the management REST API, the MCP endpoint, and plugin distribution; an opencode plugin (`plugin/`); a React 19+Vite SPA (`web/`). Repo docs/comments and TODO.md are written in Chinese.

## Layout
- `server/` — FastAPI app, entry `server/main.py:app`. Routes: `/mcp` (MCP Streamable HTTP, API-key auth), `/api/*` (JWT auth except `/api/auth/*`), `/download/*` (unauthenticated plugin distribution), `/health`.
- `plugin/` — opencode plugin (TS, entry `src/index.ts`, default-export `Plugin`). Deployed to `~/.config/opencode/plugins/agent-swarm/src/index.ts`. **Heartbeat + task execution**: reads WORKSPACE_ID from the project's `.agent-swarm.md`, heartbeats every 30s, and (workspace_call phase) receives dispatched tasks from the server. It injects NO tools — all agent-facing operations live in the server's MCP tool set.
- `web/` — SPA, dev server :8701 proxying `/api /download /mcp /health` → :8700.
- `deploy/` — bash run scripts (Linux-targeted; `.venv/bin/python`, `pgrep`/`kill`) plus `install.ps1`/`start.ps1`/`stop.ps1` Windows equivalents. install.sh is Linux-targeted.

## Commands
```bash
./deploy/start.sh [port]     # server on :8700 (default). Creates .venv, installs requirements.txt,
                             # tarballs plugin -> data/agent-swarm-plugin.tar.gz, and FOREGROUND runs
                             # uvicorn (Ctrl-C stops). Idempotent: exits if /health already OK.
.\deploy\start.ps1           # Windows equivalent (-NoWeb skips frontend build check)
./deploy/stop.sh [port]
cd web && npm run dev        # vite :8701
cd web && npm run build      # tsc -b && vite build
cd web && npm run lint       # oxlint
cd plugin && npm run typecheck
```

## Tests
There is **no committed pytest suite**. E2E is `scripts/run_e2e.sh`, but it `cd`s to a hardcoded `/home/wangxu/workdir/agent_swarm` and needs `/tmp/opencode/test_api.py` + `/tmp/opencode/test_mcp_e2e.py` that are **not in the repo** (TODO plans to move them into `scripts/`). Don't claim tests pass until you've actually run them.

## Server facts
- **All agent-facing operations are MCP tools in `server/mcp_endpoint.py`** (`@mcp.tool()`): `workspace_add/remove/enable/disable`, `heartbeat`, `update_notes/info`, `list_workspaces`, and the help-request set (`request_help`, `get_help_result`, `poll_help_requests`, `submit_help_result`, slated for redesign). Auth: `ApiKeyMiddleware` validates `Authorization: Bearer <apikey>` on every `/mcp` request and stores the user in a contextvar; tools read it via `get_user()`.
- The intended client is ANY MCP client: opencode connects via `mcp.agent-swarm` (remote URL + Bearer header) written into `opencode.jsonc` by the install scripts; claude/deepseek harnesses can connect the same way. This portability was an explicit user decision (2026-09-12) — do not move tools back into the plugin.
- Workspace ID persistence: `workspace_add` returns the ID, the calling agent writes it to `.agent-swarm.md` (`WORKSPACE_ID:` line) in the project root; the plugin reads that file every heartbeat cycle. `register_workspace`/`workspace_whoami` were deliberately removed — don't reintroduce them.
- **Current phase (2026-09-12): `workspace_call`** — a new MCP tool for cross-agent collaboration (input: target_workspace_id + instruction text). Flow: caller MCP tool → server persists & forwards to the target workspace's plugin → plugin injects the task into its opencode. Reference implementation for injection: `D:\wangxu\work\opencode-feishu` — it does NOT inject into TUI; it uses `client.session.promptAsync` on plugin-managed background sessions, polls `session.messages()` with a baseline diff, and relies on SSE `session.idle` for completion. See TODO.md "执行承载方案" for the pending design decision.
- The old sync/async help-request design is shelved: server endpoints exist, plugin-side execution was removed. Ask before wiring it back.
- MCP is Streamable HTTP + stateless: every client call does a fresh `initialize`.
- Online status is dynamic: workspaces with heartbeat older than 90s (`HEARTBEAT_TIMEOUT_SECONDS`) count as offline; plugin heartbeats every 30s. `workspace_disable` marks status=disabled; heartbeat does NOT revive a disabled workspace (only `workspace_enable` does).
- DB is SQLite at `data/agent_swarm.db` (gitignored). For a clean slate, stop the server and delete the db. `server/db.py:init_db` self-migrates (adds columns, backfills plaintext `api_key` for legacy users — this invalidates their old keys).
- Config via `server/config.py`: env vars win over root `.env`. Notable: `AGENT_SWARM_DB`, `AGENT_SWARM_JWT_SECRET` (defaults to a dev secret — set before production), `AGENT_SWARM_PUBLIC_URL` (overrides the host-derived server URL injected into install.sh).
- `teams`/`team_members` tables remain in `server/models.py` but the feature was removed (API + web gone). Don't wire them back without asking.

## Plugin facts / gotchas
- `plugin/src/config.ts` `loadConfig()` only reads `~/.config/opencode/agent-swarm.json` (or env `AGENT_SWARM_SERVER`/`AGENT_SWARM_API_KEY`); install scripts write both that file and `plugins/agent-swarm/config.json`.
- `/swarm-add` (and `/swarm-register`, `/swarm-remove`, `/swarm-enable`, `/swarm-disable`) are **not** registered by the plugin: they are markdown files in `plugin/commands/` copied to `~/.config/opencode/commands/` by install scripts. To change command behavior, edit the source md in the repo and reinstall — don't inline command text in install scripts.
- The opencode plugin runs on the user machine, not in this repo: after editing `plugin/src/`, reinstall locally via the one-liner printed on the web install page (server must be restarted first so start.ps1/start.sh rebuilds the tarball).
- **IMPORTANT: after changing `plugin/src/`, the running opencode sessions still hold the OLD plugin code** — a reinstall + opencode restart is required before any E2E test. ALWAYS notify the user and wait for them to restart opencode before running end-to-end tests; don't fire test calls and wonder why nothing happens (the plugin.log shows which version is actually loaded).

## Conventions
- Comments and handoff notes are in Chinese; keep new ones consistent (TODO.md is the running handoff doc — read it before starting work, it contains the current blocker).
- Revise files with the edit tool directly; never edit files via ad-hoc scripts (PowerShell regex pipelines, `python -c` rewrites). Scripts for file mutation are hard to review and have caused broken edits here.
- No CI, no pre-commit hooks, no codegen.