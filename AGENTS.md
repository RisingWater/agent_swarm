# AGENTS.md

> Agent-facing contributor guide (architecture decisions, gotchas, conventions). Product intro & user docs live in README.md and the web docs page — don't duplicate them here.

Multi-agent collaboration hub: agents register their workspaces (opencode, claude code, …) to a central server and ask each other for help. Single FastAPI service (`server/`) that hosts the management REST API, the MCP endpoint, and plugin distribution; per-agent plugins under `plugins/`; a React 19+Vite SPA (`web/`). Repo docs/comments and TODO.md are written in Chinese.

## Layout
- `server/` — FastAPI app, entry `server/main.py:app`. Routes: `/mcp` (MCP Streamable HTTP, API-key auth), `/api/*` (JWT auth except `/api/auth/*`), `/download/*` (unauthenticated plugin distribution), `/health`.
- `plugins/opencode/` — opencode plugin (TS, entry `src/index.ts`, default-export `Plugin`). Deployed to `~/.config/opencode/plugins/agent-swarm/src/index.ts`. **Heartbeat + task execution**: reads WORKSPACE_ID from the project's `.agent-swarm.md`, heartbeats every 30s, and receives dispatched `workspace_call` tasks. It injects NO tools — all agent-facing operations live in the server's MCP tool set.
- `plugins/claude/` — claude code integration. `keepalive.mjs` is a **zero-dependency local stdio MCP server** (minimal hand-rolled JSON-RPC: answers `initialize`/`ping`/`tools:list`/`tools:call`) that claude spawns as an MCP subprocess; on spawn it starts a 30s heartbeat loop (`agent_type=claude`), reading WORKSPACE_ID from `process.cwd()/.agent-swarm.md` each cycle. Exit: stdin close + ppid poll fallback → sends `workspace_offline` then exits → workspace goes offline immediately. Plus `commands/` (`/swarm-*` md for `~/.claude/commands/`) and `install-claude.sh|.ps1`.
- **claude task execution (v2, 2026-09-13)**: keepalive declares `experimental['claude/channel']` + `tools` capabilities — it's a **channel**. Task delivery: heartbeat piggybacks pending calls → `notifications/claude/channel` injects into the TUI session (only works when claude started with `--dangerously-load-development-channels server:agent-swarm-keepalive`, otherwise silently dropped → task times out). Completion: claude must call the `swarm_reply` MCP tool (call_id + result) → keepalive submits `workspace_call_result`. nexus: keepalive keeps a WS to `/ws/plugin` (same protocol as opencode plugin) for web-issued commands. Hooks (`hook-timeline.mjs`, registered into `~/.claude/settings.json` for PreToolUse/PostToolUse/Stop) report tool events to `POST /api/nexus/hook-events` (apikey auth → `nexus._forward_event`), **gated on `~/.claude/agent-swarm/state.json`** which keepalive writes on task injection and clears on swarm_reply — user's own tool calls never leak to the timeline. AskUserQuestion: PreToolUse hook reports the question, polls `answer-<req_id>.json` (written by keepalive on nexus `question_reply`), answers via `allow + updatedInput{answers}`; 5min timeout falls back to the local dialog. Permission relay (Bash/Write approve) intentionally NOT done in v2.
- `web/` — SPA, dev server :8701 proxying `/api /download /mcp /health` → :8700.
- `deploy/` — `start`/`stop` scripts (sh + ps1) and **installer dispatchers** (`install.sh`/`install.ps1`): download `plugin.tar.gz` (now contains the whole `plugins/` tree), extract to a temp dir, and run each `plugins/<name>/install-<name>.sh|.ps1` with `--server/--api-key/--src` passed through (`--only`/`-Only` filters).
- `docker/` — Dockerfile (multi-stage: node builds web → python runtime) + compose.yaml. Written but NOT yet build-tested (user will verify).

## Commands
```bash
./deploy/start.sh [port]     # server on :8700 (default). Creates .venv, installs requirements.txt,
                             # tarballs plugins/ -> data/agent-swarm-plugin.tar.gz, and FOREGROUND runs
                             # uvicorn (Ctrl-C stops). Idempotent: exits if /health already OK.
.\deploy\start.ps1           # Windows equivalent (-NoWeb skips frontend build check)
./deploy/stop.sh [port]
cd web && npm run dev        # vite :8701
cd web && npm run build      # tsc -b && vite build
cd web && npm run lint       # oxlint
cd plugins/opencode && npm run typecheck
```

## Tests
There is **no committed pytest suite** and no maintained E2E suite (user decided to drop e2e script work for now — 2026-09-12). Don't claim tests pass until you've actually run them.

## Server facts
- **All agent-facing operations are MCP tools in `server/mcp_endpoint.py`** (`@mcp.tool()`), 13 total: `workspace_add/remove/enable/disable/offline`, `heartbeat`, `update_notes/info`, `list_workspaces`, `workspace_call`, `workspace_call_status`, `workspace_call_ack`, `workspace_call_result` (the last two are plugin-internal; agents use the first one of each pair). Auth: `ApiKeyMiddleware` validates `Authorization: Bearer <apikey>` on every `/mcp` request and stores the user in a contextvar; tools read it via `get_user()`.
- The intended client is ANY MCP client: opencode connects via `mcp.agent-swarm` (remote URL + Bearer header) written into `opencode.jsonc` by the install scripts; claude/deepseek harnesses can connect the same way. This portability was an explicit user decision (2026-09-12) — do not move tools back into the plugin.
- Workspace ID persistence: `workspace_add` returns the ID, the calling agent writes it to `.agent-swarm.md` (`WORKSPACE_ID:` line) in the project root; the plugin reads that file every heartbeat cycle. `register_workspace`/`workspace_whoami` were deliberately removed — don't reintroduce them.
- **workspace_call task dispatch**: heartbeat response piggybacks pending calls (`calls` field) — no separate polling channel. REST mirror: `/api/calls` (list) + `DELETE /api/calls/{id}` (only done/failed, ownership checked). Timeout: `AGENT_SWARM_CALL_TIMEOUT` (default 1h), enforced lazily in `workspace_call_status`.
- MCP is Streamable HTTP + stateless: every client call does a fresh `initialize`.
- Online status is dynamic: workspaces with heartbeat older than 90s (`HEARTBEAT_TIMEOUT_SECONDS`) count as offline; plugin heartbeats every 30s. `workspace_disable` marks status=disabled; heartbeat does NOT revive a disabled workspace (only `workspace_enable` does).
- DB is SQLite at `data/agent_swarm.db` (gitignored). For a clean slate, stop the server and delete the db. `server/db.py:init_db` self-migrates (adds columns, backfills plaintext `api_key` for legacy users — this invalidates their old keys; it also DROPs the old `help_requests` table).
- Config via `server/config.py`: env vars win over root `.env`. Notable: `AGENT_SWARM_DB`, `AGENT_SWARM_JWT_SECRET` (defaults to a dev secret — set before production), `AGENT_SWARM_PUBLIC_URL` (overrides the host-derived server URL injected into install scripts), `AGENT_SWARM_CALL_TIMEOUT`.
- `teams`/`team_members` tables remain in `server/models.py` but the feature was removed (API + web gone). Don't wire them back without asking (user chose to KEEP them, 2026-09-12).

## Plugin facts / gotchas
- **Installer structure (2026-09-13)**: `deploy/install.sh|.ps1` are dispatchers only; per-agent logic lives in `plugins/<name>/install-<name>.sh|.ps1` (dispatch passes `--server/--api-key/--src`). The tarball contains the whole `plugins/` tree — `deploy/start.*` tarballs `-C . plugins` (not `-C plugin`).
- **ps1 encoding**: Chinese-containing ps1 scripts that get **executed as local files** (the per-plugin installers, copied out of the tarball) MUST be saved UTF-8 **with BOM** — PS 5.1 reads BOM-less files as ANSI and Chinese bytes then eat quotes/newlines, breaking parsing (verified failure mode). The dispatcher `deploy/install.ps1` also has BOM now (local execution), but the server's `/download/install.ps1` endpoint strips it via `read_text(utf-8-sig)` so `irm | iex` stays safe.
- **NEVER parse/merge user JSON config from PowerShell** (settings.json clobber incident 2026-09-13): `ConvertFrom-Json -AsHashtable` does NOT exist in PS 5.1 — parse throws, catch fell back to `{}`, and writing back wiped the user's `env` (deepseek relay config) + `theme`. All settings.json merging goes through `plugins/claude/merge-hooks.mjs` (node, shared by ps1/sh installers) which preserves unknown fields. Rule: PS 5.1 touches JSON only via node. Also: PS has no heredoc (`<<'EOF'` is bash-only) — don't paste bash-isms into ps1.
- `plugins/opencode/src/config.ts` `loadConfig()` only reads `~/.config/opencode/agent-swarm.json` (or env `AGENT_SWARM_SERVER`/`AGENT_SWARM_API_KEY`); install scripts write both that file and `plugins/agent-swarm/config.json`.
- `/swarm-add` (and `/swarm-register`, `/swarm-remove`, `/swarm-enable`, `/swarm-disable`) are **not** registered by the plugin: they are markdown files in `plugins/<name>/commands/` copied to `~/.config/opencode/commands/` (opencode) or `~/.claude/commands/` (claude) by install scripts. To change command behavior, edit the source md in the repo and reinstall — don't inline command text in install scripts. claude copies use `mcp__agent-swarm__*` tool naming in the md body.
- The opencode plugin runs on the user machine, not in this repo: after editing `plugins/opencode/src/`, reinstall locally via the one-liner printed on the web install page (server must be restarted first so start.ps1/start.sh rebuilds the tarball).
- **IMPORTANT: after changing `plugins/opencode/src/`, the running opencode sessions still hold the OLD plugin code** — a reinstall + opencode restart is required before any E2E test. ALWAYS notify the user and wait for them to restart opencode before running end-to-end tests; don't fire test calls and wonder why nothing happens (the plugin.log shows which version is actually loaded).
- **Task injection is foreground-first** (user decision 2026-09-12): target = event-hook-tracked current session (cold start: `session.list` picks most recent + `tui.showToast` notice); if fgBusy or target session busy (`session.status`), queue-wait up to 10 min; background `session.create` only as last resort. Completion = `session.idle` event + 2s polling fallback; stuck-on-tool-call gets synthetic nudges (≤2).
- **claude keepalive lifecycle**: `claude mcp list` health checks also spawn/exit the keepalive process (stdin-close exit is by design). Multiple claude sessions on one project → multiple keepalives heartbeating the same workspace, harmless (server-side idempotent). `claude mcp list` output format is `name: ... - ✔ Connected` — idempotency checks in install-claude must match `name:` (with colon).

## Web facts / gotchas
- Frontend is user-facing: docs page (`web/src/App.tsx` `DocsPage`) intentionally contains NO server-deployment content — the user is already looking at a running deployment. Keep it that way.
- Video `web/public/agent_swarm.mp4` (~39MB) is committed as a regular blob (user accepted; LFS considered and skipped for now). Autoplays once muted when scrolled into view, stops on last frame, no controls.
- Results in call records render as markdown (react-markdown + remark-gfm) — task prompts ask agents to summarize in markdown-friendly prose.
- Auth UX: logged-out visitors see Home/Docs only + a login *modal* (not a page); protected nav items hidden. Account page (click username) has a left sub-menu: API Key | change password.

## Conventions
- Comments and handoff notes are in Chinese; keep new ones consistent (TODO.md is the running handoff doc — read it before starting work).
- Revise files with the edit tool directly; never edit files via ad-hoc scripts (PowerShell regex pipelines, `python -c` rewrites). Scripts for file mutation are hard to review and have caused broken edits here.
- No CI, no pre-commit hooks, no codegen.