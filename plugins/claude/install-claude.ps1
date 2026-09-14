# agent_swarm claude code 插件安装子脚本（由 deploy\install.ps1 分发器调用）。
# 做四件事：
#   1. 复制 keepalive.mjs 到安装目录并写配置
#   2. claude mcp add 注册 remote MCP（12 个 workspace_* 工具）
#   3. claude mcp add 注册本地 keepalive MCP（spawn 保活进程）
#   4. 拷贝 /swarm-* 命令到 ~/.claude/commands/
#
# 也支持环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

param(
    [string]$Server,
    [string]$ApiKey,
    [string]$Src,
    [string]$InstallDir = (Join-Path $HOME ".claude\agent-swarm")
)

$ErrorActionPreference = "Stop"

if (-not $Src) { $Src = $PSScriptRoot }
if (-not $Server) { $Server = $env:AGENT_SWARM_SERVER }
if (-not $ApiKey) { $ApiKey = $env:AGENT_SWARM_API_KEY }
$Server = $Server.TrimEnd("/")

if (-not $Server -or $Server -notmatch "://") {
    Write-Host "错误: 缺少 -Server 参数（agent_swarm 服务地址，如 http://10.0.0.1:8700）" -ForegroundColor Red
    exit 1
}
if (-not $ApiKey) {
    Write-Host "错误: 缺少 -ApiKey 参数（在管理页面「API Key」页获取）" -ForegroundColor Red
    exit 1
}

Write-Host "==> [claude] 安装插件"
Write-Host "    服务器: $Server"
Write-Host "    目录:   $InstallDir"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 claude 命令，请先安装 Claude Code" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 node（keepalive 需要），请先安装 Node.js" -ForegroundColor Red
    exit 1
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1. 复制插件文件到安装目录 + 写配置（keepalive.mjs 读取）
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $Src "keepalive.mjs") -Destination $InstallDir -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $Src "nexus_a2a.mjs") -Destination $InstallDir -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $Src "background.mjs") -Destination $InstallDir -Force -ErrorAction SilentlyContinue
$cfg = @{ serverUrl = $Server; apiKey = $ApiKey } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $InstallDir "config.json"), $cfg, $utf8NoBom)

# 2. 注册 remote MCP（工具直连；幂等：已存在则跳过）
$mcpList = & claude mcp list 2>&1 | Out-String
if ($mcpList -match "(?m)^\s*agent-swarm\s*:") {
    Write-Host "==> mcp agent-swarm 已注册，跳过"
} else {
    & claude mcp add --scope user --transport http agent-swarm "$Server/mcp/" --header "Authorization: Bearer $ApiKey"
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add agent-swarm failed" }
    Write-Host "==> 已注册 remote MCP agent-swarm"
}

# 3. 注册本地 keepalive MCP（spawn 保活进程；幂等）
$keepalive = Join-Path $InstallDir "keepalive.mjs"
if (-not (Test-Path $keepalive)) {
    Write-Host "警告: keepalive.mjs 不在分发包中，跳过保活注册（仅命令可用）" -ForegroundColor Yellow
} elseif ($mcpList -match "(?m)^\s*agent-swarm-keepalive\s*:") {
    # 已注册也要确保命令路径指向最新安装目录
    & claude mcp remove --scope user agent-swarm-keepalive 2>$null | Out-Null
    & claude mcp add --scope user agent-swarm-keepalive -- node $keepalive
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add agent-swarm-keepalive failed" }
    Write-Host "==> 已更新本地 MCP agent-swarm-keepalive"
} else {
    & claude mcp add --scope user agent-swarm-keepalive -- node $keepalive
    if ($LASTEXITCODE -ne 0) { throw "claude mcp add agent-swarm-keepalive failed" }
    Write-Host "==> 已注册本地 MCP agent-swarm-keepalive（保活）"
}

# 4. 注册自定义命令（markdown 源文件在 commands/，拷贝即安装）
$cmdDir = Join-Path $HOME ".claude\commands"
New-Item -ItemType Directory -Force -Path $cmdDir | Out-Null
Get-ChildItem (Join-Path $Src "commands") -Filter "swarm-*.md" -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $cmdDir $_.Name) -Force
    Write-Host "    已注册命令 /$($_.BaseName)"
}

Write-Host "✅ [claude] 安装完成！重启 claude 后：MCP 工具可用，keepalive 自动心跳保活。"
