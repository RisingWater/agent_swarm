# agent_swarm 服务启动脚本（Windows PowerShell 5.1+；对应 start.sh 的 Windows 版）
# 用法: .\deploy\start.ps1 [-Port 8700] [-NoWeb]
#   单端口模式：后端 :8700 同时服务 API/MCP 和管理前端（web/dist 构建产物）。
#   后端前台运行，Ctrl-C 停止。
#   默认检查并构建前端（dist 缺失或源码有更新时）；-NoWeb 跳过前端构建。
# 环境变量:
#   AGENT_SWARM_PORT        后端端口（默认 8700；-Port 参数优先）
#   AGENT_SWARM_DB          SQLite 路径（默认 <项目根>/data/agent_swarm.db）
#   AGENT_SWARM_JWT_SECRET  JWT 签名密钥（生产环境务必设置）
#   PYTHON                  创建 venv 用的解释器（默认 python）

param(
    [int]$Port = 0,
    [switch]$NoWeb   # 跳过前端构建检查（只起后端）
)

$ErrorActionPreference = "Stop"

if (-not $Port) {
    $Port = if ($env:AGENT_SWARM_PORT) { [int]$env:AGENT_SWARM_PORT } else { 8700 }
}

$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot

$python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"

# 1. 虚拟环境：不存在则创建，依赖缺失则安装
if (-not (Test-Path $venvPython)) {
    Write-Host "[deploy] creating venv with $python ..."
    & $python -m venv .venv
}

# 用 cmd 包一层隐藏输出：PS 5.1 里重定向原生命令的 stderr 会误触 EAP=Stop
cmd /c "`"$venvPython`" -c ""import fastapi, mcp, sqlmodel"" >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[deploy] installing dependencies ..."
    & $venvPython -m pip install --upgrade pip -q
    & $venvPython -m pip install -r requirements.txt -q
}

# 2. 打包插件到 data\（供 /download/plugin.tar.gz 分发；plugins\ 下所有 agent 插件）
New-Item -ItemType Directory -Force -Path data | Out-Null
if (Get-Command tar.exe -ErrorAction SilentlyContinue) {
    tar -czf data\agent-swarm-plugin.tar.gz -C . --exclude=node_modules --exclude=types --exclude="*.tsbuildinfo" plugins
    if ($LASTEXITCODE -ne 0) { throw "plugin tarball failed" }
    Write-Host "[deploy] plugin package: data\agent-swarm-plugin.tar.gz"
} else {
    Write-Host "[deploy] warning: 未找到 tar.exe（Win10 1803+ 自带），/download/plugin.tar.gz 将不可用" -ForegroundColor Yellow
}

# 3. 管理前端：dist 缺失或 src 源码比 dist 新时重新构建（-NoWeb 跳过）
$webDist = Join-Path $projectRoot "web\dist"
if (-not $NoWeb) {
    $needBuild = -not (Test-Path (Join-Path $webDist "index.html"))
    if (-not $needBuild) {
        $latestSrc = Get-ChildItem (Join-Path $projectRoot "web\src"), (Join-Path $projectRoot "web\index.html"), (Join-Path $projectRoot "web\vite.config.ts") -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latestSrc -and $latestSrc.LastWriteTime -gt (Get-Item (Join-Path $webDist "index.html")).LastWriteTime) {
            $needBuild = $true
        }
    }
    if ($needBuild) {
        if (-not (Test-Path (Join-Path $projectRoot "web\node_modules"))) {
            Write-Host "[deploy] installing web dependencies ..."
            Push-Location web
            try { & npm install --no-audit --no-fund --loglevel=error } finally { Pop-Location }
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        }
        Write-Host "[deploy] building web ..."
        Push-Location web
        try { & npm run build } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "web build failed" }
    }
}

# 4. 幂等检查：已在跑则提示并退出
try {
    if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/health").StatusCode -eq 200) {
        Write-Host "[deploy] agent_swarm already running on :$Port"
        exit 0
    }
} catch {}

# 5. 启动后端（前台运行；Ctrl-C 停止。需后台托管时用 Start-Process / 计划任务自行调整）
$dbDisplay = if ($env:AGENT_SWARM_DB) { $env:AGENT_SWARM_DB } else { "data\agent_swarm.db" }
$webHint = if (Test-Path (Join-Path $webDist "index.html")) { ", web: http://127.0.0.1:$Port" } else { "" }
Write-Host "[deploy] starting agent_swarm on :$Port (db: $dbDisplay$webHint)"
& $venvPython -m uvicorn server.main:app --host 0.0.0.0 --port $Port
