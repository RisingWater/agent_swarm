# agent_swarm 服务停止脚本（Windows PowerShell 5.1+；对应 stop.sh 的 Windows 版）
# 用法: .\deploy\stop.ps1 [-Port 8700] [-WebPort 8701]
#   -WebPort 0 表示不处理前端。

param(
    [int]$Port = 0,
    [int]$WebPort = 0
)

$ErrorActionPreference = "SilentlyContinue"

if (-not $Port) {
    $Port = if ($env:AGENT_SWARM_PORT) { [int]$env:AGENT_SWARM_PORT } else { 8700 }
}
if (-not $WebPort) {
    $WebPort = if ($env:AGENT_SWARM_WEB_PORT) { [int]$env:AGENT_SWARM_WEB_PORT } else { 8701 }
}

# 按 TCP 监听端口找 PID（Windows 没有 pgrep，按命令行匹配不可靠）
$backendPids = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess | Sort-Object -Unique
if ($backendPids) {
    foreach ($p in $backendPids) {
        Write-Host "[deploy] stopping backend pid $p (: $Port)"
        # uvicorn 可能有子进程，用 taskkill 连树杀
        & taskkill /PID $p /T /F | Out-Null
    }
} else {
    Write-Host "[deploy] no running agent_swarm on :$Port"
}

$webPids = (Get-NetTCPConnection -LocalPort $WebPort -State Listen).OwningProcess | Sort-Object -Unique
if ($webPids) {
    foreach ($p in $webPids) {
        Write-Host "[deploy] stopping web pid $p (: $WebPort)"
        & taskkill /PID $p /T /F | Out-Null
    }
}
