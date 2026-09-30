# agent_swarm deepseek harness 插件安装子脚本（由 deploy/install.ps1 分发器调用）。
# 做四件事：
#   1. 检查 dsh 命令可用
#   2. 写全局配置 ~/.config/dsh/agent-swarm.json
#   3. dsh plugin add 安装 bundle（默认 profile；-Profile 指定其它）
#   4. 注册工作区：对当前目录调 MCP workspace_add（agent_type=deepseek），写 .agent_swarm/workspace.md
#
# 也支持环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY
# 注意：含中文的 ps1 必须存 UTF-8 带 BOM（PS 5.1 本地执行读 BOM）。

param(
    [string]$Server,
    [string]$ApiKey,
    [string]$Src,
    [string]$Profile = "",
    [string]$Path = (Get-Location).Path
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

Write-Host "==> [deepseek] 安装插件"
Write-Host "    服务器: $Server"

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 dsh 命令，请先安装 DeepSeek Harness（npx @deepseek-ai/dsh 或源码 pnpm dsh）" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 node（编译插件需要），请先安装 Node.js 22+" -ForegroundColor Red
    exit 1
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1. 安装 bundle：把插件目录复制到固定位置并 dsh plugin add（本地路径免构建脚本）
$bundleDir = Join-Path $HOME ".dsh\agent-swarm-plugin"
New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
Copy-Item -Path (Join-Path $Src "package.json") -Destination $bundleDir -Force
Copy-Item -Path (Join-Path $Src "cordis.patch.yml") -Destination $bundleDir -Force
Copy-Item -Path (Join-Path $Src "index.ts") -Destination $bundleDir -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $Src "src") -Destination $bundleDir -Recurse -Force

# dsh 以 tsx 加载源码（源码运行形态），bundle main 指向 js 转发器即可
$forwarder = @"
// 由 install 脚本生成：转发到 TypeScript 源码（dsh 运行时自带 tsx 加载）
export { apply, name } from "./src/index.ts"
"@
[IO.File]::WriteAllText((Join-Path $bundleDir "index.js"), $forwarder, $utf8NoBom)
$addArgs = @("plugin")
if ($Profile) { $addArgs += @("--profile", $Profile) }
$addArgs += @("add", $bundleDir)
Write-Host "==> dsh $($addArgs -join ' ')（安装 bundle）"
& dsh @addArgs
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed（若 pnpm 提示 allowBuilds，按提示把键加入 profile 的 pnpm-workspace.yaml 后重跑）" }

# 2. 写全局配置
$cfgDir = Join-Path $HOME ".config\dsh"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = @{ serverUrl = $Server; apiKey = $ApiKey } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $cfgDir "agent-swarm.json"), $cfg, $utf8NoBom)
Write-Host "==> 已写配置 $cfgDir\agent-swarm.json"

# 3. 注册工作区：调 MCP workspace_add（agent_type=deepseek）并写 .agent_swarm/workspace.md
$wsMd = Join-Path $Path ".agent_swarm\workspace.md"
$existingId = ""
if (Test-Path $wsMd) {
    $m = Select-String -Path $wsMd -Pattern "^\s*(?:#\+\s*)?WORKSPACE_ID[:：]\s*([A-Za-z0-9_-]+)" | Select-Object -First 1
    if ($m) { $existingId = $m.Matches[0].Groups[1].Value }
}
if ($existingId) {
    Write-Host "==> 工作区已注册：$existingId（$wsMd）"
} else {
    Write-Host "==> 注册工作区（$Path）..."
    $regScript = Join-Path $bundleDir "register.mjs"
    & node $regScript --server $Server --api-key $ApiKey --path $Path --agent-type deepseek
    if ($LASTEXITCODE -ne 0) {
        Write-Host "警告: 工作区注册失败（服务端不可达？）。稍后在 $Path 目录用 dsh 里的 agent 手动注册也可。" -ForegroundColor Yellow
    }
}

Write-Host "✅ [deepseek] 安装完成！重启 dsh（dsh web）后插件自动加载：心跳在线、任务落 per-caller 会话。"
