# AGENTS.md

Multi-agent collaboration hub: agents register their opencode workspaces to a central server and ask each other for help. Single FastAPI service (`server/`) that hosts the management REST API, the MCP endpoint, and plugin distribution; an opencode plugin (`plugin/`); a React 19+Vite SPA (`web/`). Repo docs/comments and TODO.md are written in Chinese.

## Layout
- `server/` — FastAPI app, entry `server/main.py:app`. Routes: `/mcp` (MCP Streamable HTTP, API-key auth), `/api/*` (JWT auth except `/api/auth/*`), `/download/*` (unauthenticated plugin distribution), `/health`.
- `plugin/` — opencode plugin (TS, entry `src/index.ts`, default-export `Plugin`). Deployed to `~/.config/opencode/plugins/agent-swarm/src/index.ts`. **Heartbeat-only** since 2026-09-12: it looks up the workspace via `workspace_whoami` and keeps it online; it injects NO tools.
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
- **All agent-facing operations are MCP tools in `server/mcp_endpoint.py`** (`@mcp.tool()`): `workspace_add/remove/enable/disable/whoami`, `register_workspace`, `heartbeat`, `update_notes/info`, `list_workspaces`, and the help-request set (`request_help`, `get_help_result`, `poll_help_requests`, `submit_help_result`, currently dormant). Auth: `ApiKeyMiddleware` validates `Authorization: Bearer <apikey>` on every `/mcp` request and stores the user in a contextvar; tools read it via `get_user()`.
- The intended client is ANY MCP client: opencode connects via `mcp.agent-swarm` (remote URL + Bearer header) written into `opencode.jsonc` by the install scripts; claude/deepseek harnesses can connect the same way. This portability was an explicit user decision (2026-09-12) — do not move tools back into the plugin.
- Help-request cross-agent dispatch is shelved: server endpoints exist, plugin-side execution was removed. Ask before wiring it back.
- MCP is Streamable HTTP + stateless: every client call does a fresh `initialize`.
- Online status is dynamic: workspaces with heartbeat older than 90s (`HEARTBEAT_TIMEOUT_SECONDS`) count as offline; plugin heartbeats every 30s. `workspace_disable` marks status=disabled; heartbeat does NOT revive a disabled workspace (only `workspace_enable` does).
- DB is SQLite at `data/agent_swarm.db` (gitignored). For a clean slate, stop the server and delete the db. `server/db.py:init_db` self-migrates (adds columns, backfills plaintext `api_key` for legacy users — this invalidates their old keys).
- Config via `server/config.py`: env vars win over root `.env`. Notable: `AGENT_SWARM_DB`, `AGENT_SWARM_JWT_SECRET` (defaults to a dev secret — set before production), `AGENT_SWARM_PUBLIC_URL` (overrides the host-derived server URL injected into install.sh).
- `teams`/`team_members` tables remain in `server/models.py` but the feature was removed (API + web gone). Don't wire them back without asking.

## Plugin facts / gotchas
- `plugin/src/config.ts` `loadConfig()` only reads `~/.config/opencode/agent-swarm.json` (or env `AGENT_SWARM_SERVER`/`AGENT_SWARM_API_KEY`); install scripts write both that file and `plugins/agent-swarm/config.json`.
- `/swarm` is **not** registered by the plugin: it is `~/.config/opencode/commands/swarm.md` written by install scripts, routing subcommands (register/add/remove/enable/disable) to the MCP tools.
- The opencode plugin runs on the user machine, not in this repo: after editing `plugin/src/`, reinstall locally via the one-liner printed on the web install page (server must be restarted first so start.ps1/start.sh rebuilds the tarball).

## Conventions
- Comments and handoff notes are in Chinese; keep new ones consistent (TODO.md is the running handoff doc — read it before starting work, it contains the current blocker).
- Revise files with the edit tool directly; never edit files via ad-hoc scripts (PowerShell regex pipelines, `python -c` rewrites). Scripts for file mutation are hard to review and have caused broken edits here.
- No CI, no pre-commit hooks, no codegen.