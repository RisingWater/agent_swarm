# agent_swarm 规划核心服务（planner）一键安装脚本（平台分发，Windows / PowerShell 5.1+）
# 用法：& ([scriptblock]::Create((irm <平台地址>/download/planner-install.ps1))) -ApiKey as_xxx
# 作用：把 agent_swarm_planner 克隆到 ~/.agent_swarm/agent_swarm_planner（已存在则更新到最新），
#       再运行其 deploy/install.ps1 完成安装（建 venv / 装依赖 / 写配置 / 注册开机自启）。
# 装完后在项目目录的 harness 里执行 /swarm-add-planner 完成注册。
param(
    [string]$Server = "__SERVER_URL__",
    [string]$ApiKey = "",
    [string]$Repo = "https://github.com/RisingWater/agent_swarm_planner.git",
    [string]$Dir = "$HOME\.agent_swarm\agent_swarm_planner",
    [string]$Branch = "master"
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "需要 git，请先安装" }

if (Test-Path (Join-Path $Dir ".git")) {
    Write-Host "==> 更新已有仓库 $Dir"
    git -C $Dir fetch --depth 1 origin $Branch
    git -C $Dir checkout -q $Branch
    git -C $Dir reset --hard "origin/$Branch"
} else {
    Write-Host "==> 克隆 $Repo -> $Dir"
    New-Item -ItemType Directory -Force -Path (Split-Path $Dir -Parent) | Out-Null
    git clone --depth 1 --branch $Branch $Repo $Dir
}

$installArgs = @("-Server", $Server)
if ($ApiKey) { $installArgs += @("-ApiKey", $ApiKey) }
Write-Host "==> 运行安装：$Dir\deploy\install.ps1 $($installArgs -join ' ')"
& (Join-Path $Dir "deploy\install.ps1") @installArgs
