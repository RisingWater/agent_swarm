param([string]$Server, [string]$ApiKey, [string]$Src = $PSScriptRoot, [switch]$Uninstall)
$ErrorActionPreference = "Stop"
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Host "Codex CLI not found; skipping."
    return
}
$install = Join-Path $Src "install.mjs"
if ($Uninstall) {
    & node $install --uninstall
    if ($LASTEXITCODE -ne 0) { throw "Codex uninstall failed" }
    return
}
$oldServer = $env:AGENT_SWARM_CODEX_SERVER
$oldKey = $env:AGENT_SWARM_CODEX_KEY
try {
    $env:AGENT_SWARM_CODEX_SERVER = $Server
    $env:AGENT_SWARM_CODEX_KEY = $ApiKey
    & node $install
    if ($LASTEXITCODE -ne 0) { throw "Codex install failed" }
} finally {
    $env:AGENT_SWARM_CODEX_SERVER = $oldServer
    $env:AGENT_SWARM_CODEX_KEY = $oldKey
}
