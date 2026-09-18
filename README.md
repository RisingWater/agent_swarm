# agent_swarm

<p align="center">
  <b>Multi-agent collaboration hub (the Swarm)</b><br/>
  Turn your AI coding tools into a swarm that calls each other and ships tasks together
</p>

<p align="center">
  <a href="./README_CN.md">中文文档</a> ·
  <a href="./LICENSE">License: AGPL-3.0</a> ·
  <a href="./LICENSE-COMMERCIAL.md">Commercial License</a>
</p>

<div align="center">

![Home](docs/images/index.png)

</div>

## Features at a Glance

- **🔗 Standard MCP tools** — All agent-facing operations are standard MCP tools; any MCP-capable client (opencode, claude code, …) can join the swarm
- **🐝 Cross-agent task dispatch** — Hand a task to another workspace's agent with one instruction: foreground injection (visible in their TUI) or background session (silent execution), results flow back automatically
- **🌐 Web hub (Nexus)** — Dispatch instructions from the browser, watch thinking / tool calls / answers stream in real time, answer permission requests remotely
- **👀 Monitor mode** — Your everyday TUI conversations sync round-by-round to the web hub, like an observation window into your agent
- **💬 Feishu (Lark) integration** — Bind Feishu to dispatch tasks from chat, receive live timeline cards and completion briefs, answer permission requests on the go
- **🛡️ Self-hosted & lightweight** — A single FastAPI service + SQLite, one command to start, your data stays on your machine
- **🎛️ Admin console** — Separately-authenticated admin UI: users / workspaces / task-volume dashboard

## Deployment

### Option 1: Docker (recommended)

Images are built automatically by GitHub Actions and pushed to GHCR (`ghcr.io/risingwater/agent_swarm`).

```bash
# Pull and start (compose.yaml carries the full parameters)
docker compose -f docker/compose.yaml up -d

# Private registry requires a GHCR login first (token with read:packages)
echo <GITHUB_TOKEN> | docker login ghcr.io -u <username> --password-stdin
```

Or run manually without compose:

```bash
docker run -d --name agent-swarm -p 8700:8700 \
  -v agent-swarm-data:/app/data \
  -v /path/to/.env:/app/.env \
  ghcr.io/risingwater/agent_swarm:latest
```

Build the image locally:

```bash
docker build -t agent-swarm -f docker/Dockerfile .
```

> Versioning: pushing a `v*` / `release*` tag publishes `:latest` plus a version tag; `alpha*` / `beta*` tags publish pre-release tags; a manual run from the Actions page publishes `:dev`.

### Option 2: Run from source

```bash
# Linux / macOS (creates venv, installs deps, packs plugins; runs in foreground)
./deploy/start.sh                # defaults to :8700

# Windows
.\deploy\start.ps1
```

Open `http://localhost:8700`, register an account, and copy your API key from the "API Key" page.

### Connect an agent workspace

On the machine that runs your AI coding tool, run the install command generated on the home page:

```bash
# Linux / macOS
curl -fsSL http://<server>:8700/download/install.sh | bash -s -- --api-key <your-key>

# Windows (PowerShell)
& ([scriptblock]::Create((irm http://<server>:8700/download/install.ps1))) -ApiKey <your-key>
```

- **opencode**: writes the service config → registers the MCP endpoint → deploys the heartbeat plugin → copies `/swarm-*` commands. **Takes effect after restarting opencode**
- **claude code**: registers a remote MCP + local keepalive (heartbeat) → copies `/swarm-*` commands. **Takes effect after restarting claude**; claude supports background sessions only, no foreground injection

### Connect Feishu (optional)

1. Create a custom app on the [Feishu Open Platform](https://open.feishu.cn) and enable the bot capability
2. Configure event subscription (long-connection mode), add `im:message` send/receive plus `contact:user.basic_profile:readonly` scopes, and publish a version
3. Configure the server `.env`:

```ini
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

Restart the service, then send `/swarm bind as_your-key` to the bot in Feishu.

## Features in Detail

### Web hub (Nexus)

<div align="center">

![Nexus hub](docs/images/nexus.png)

</div>

Pick an online workspace on the "Nexus" page and type an instruction:

- The timeline streams the agent's **thinking, tool calls and answers**
- Permission requests and AI questions can be **answered right on the page** — no need to walk back to the terminal
- History is persisted; scroll up to load earlier rounds
- Background tasks are grouped into separate sessions by source; foreground injection lands in the peer's current session, visible in real time

### Monitor mode

When enabled (on by default for opencode, toggle with `/swarm-monitor` in the TUI), your everyday TUI conversations sync to the web hub round-by-round: question, thinking, tool calls, answer — all visible, permission requests answerable remotely. Each round is archived as a `[monitor]` record on the Calls page.

A workspace has at most one foreground round: starting a new round automatically closes the previous one, so entries never get stuck in "running" forever.

### Feishu (nexus-feishu)

After binding (`/swarm bind as_xxx`):

| Capability | Description |
|---|---|
| Dispatch | Plain text = an instruction to the selected workspace |
| Live timeline | Windows with monitor on receive TUI rounds as a card group (user card → 💭 thinking → one card per tool → 🤖 final answer) |
| Completion brief | A summary card when a task completes/fails (on by default, `/swarm brief off` to disable) |
| Permission/question card | When any workspace's task awaits input, an actionable card is pushed so you can approve/reject remotely |
| Command menu | Unknown commands return a menu card: status summary + state-filtered command buttons |

Chat commands: `/swarm bind` · `unbind` · `list` · `select` · `status` · `monitor on|off` · `brief on|off` · `last`. Workspace/monitor/brief can also be managed on the web under "Account → Chat bindings"; Feishu receives a notification on every change.

### Admin console

Visit `/#/admin` (separate login, credentials in the config table):

- **Dashboard**: users / online workspaces / total tasks + a 30-day daily task line chart
- **Users**: list (incl. bound Feishu IDs), password reset (one-time password shown, API keys untouched)
- **Workspaces**: full list (owner / purpose / current session / online status / 24h call count)

### Call records

All cross-agent calls, hub instructions, monitor rounds and Feishu dispatches are archived: sender / target / instruction / status / result, filterable by workspace and deletable.

## MCP Tools (`/mcp/`, Bearer apikey auth)

| Tool | Description |
|---|---|
| `workspace_add` | Register the current directory as a workspace, returns its ID (written to `.agent_swarm/workspace.md`) |
| `workspace_remove` / `workspace_enable` / `workspace_disable` / `workspace_offline` | Workspace management (remove only when offline) |
| `heartbeat` | Keep-alive, reports the current session (called by the plugin every 30s) |
| `update_info` / `update_notes` | Update workspace purpose/capabilities and notes |
| `list_workspaces` | List visible workspaces (online only by default) |
| `a2a_call` | Dispatch tasks via the A2A protocol: internal workspace ID or external A2A agent endpoint URL (`from_workspace` identifies the caller) |
| `a2a_task` | Query A2A task status and result |

## Configuration

| Variable | Description | Default |
|---|---|---|
| `AGENT_SWARM_PORT` | Server port | `8700` |
| `AGENT_SWARM_DB` | SQLite path | `<project root>/data/agent_swarm.db` |
| `AGENT_SWARM_JWT_SECRET` | JWT signing secret (**required in production**) | dev secret |
| `AGENT_SWARM_PUBLIC_URL` | Public URL (injected into install scripts when behind a reverse proxy) | inferred from request Host |
| `AGENT_SWARM_CALL_TIMEOUT` | Cross-agent call timeout | `3600`s |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin console login (default `admin` / `Admin123!@#`, **change in production**) | `admin` / `Admin123!@#` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Feishu custom-app credentials (the Feishu gateway starts when both are set) | not set: disabled |

Environment variables take precedence over the project-root `.env`.

## Repository Layout

```
server/            FastAPI service (api/ REST, mcp_endpoint.py MCP tools, feishu/ Feishu gateway, download.py plugin distribution)
plugins/opencode/  opencode plugin (TS): heartbeat, task execution, monitor reporting, hub connection; commands/ hosts /swarm-* sources
plugins/claude/    claude code integration: keepalive.mjs (local MCP keep-alive) + background tasks + /swarm-* commands
web/               React admin frontend (home, docs, hub, workspaces, calls, account, admin console)
deploy/            start/stop scripts + installer dispatchers (sh + ps1)
docker/            Dockerfile + compose.yaml
docs/              supplementary docs and screenshots
```

## Development

```bash
./deploy/start.sh                        # server (restart after editing server/; repacks plugins/ into data/)
cd web && npm run dev                    # frontend dev :8701 (proxies /api /mcp /download to 8700)
cd web && npm run build                  # frontend build (served statically on 8700)
cd web && npm run lint                   # oxlint
cd plugins/opencode && npm run typecheck # opencode plugin type check
```

> After editing `plugins/opencode/src/`, reinstall the plugin and **restart opencode** (running sessions hold the old code).
> ps1 install scripts containing Chinese must be saved as UTF-8 **with BOM** (local PS 5.1 reads BOM-less files as ANSI, breaking syntax); the dispatcher itself is delivered as text via `irm | iex`, so no BOM is needed there.

## Security

- MCP and REST are fully authenticated (apikey / JWT); `/download/*` and `/health` excepted
- SQLite stores the plaintext apikey so users can view it anytime; set the JWT secret in production
- Cross-agent tasks are injected into the target workspace's session — only connect machines you trust

## License

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

This project is **dual-licensed**:

- **Open source**: [AGPL-3.0-only](./LICENSE) — free for learning, internal tools and open derivatives (all AGPL obligations apply, including the network clause: serving it over a network requires releasing your source).
- **Commercial**: for closed-source integration, SaaS without opening your source, etc. — see the [Commercial License](./LICENSE-COMMERCIAL.md).

Before contributing, please read [CLA.md](./CLA.md) — submitting a PR means you accept its terms (granting the copyright holder the right to relicense your contribution commercially).
