# agent_swarm deepseek harness 插件安装子脚本（由 deploy/install.ps1 分发器调用）。
# 做四件事：
#   1. 检查 dsh 命令可用
#   2. 写全局配置 ~/.config/dsh/agent-swarm.json
#   3. dsh plugin add 安装 bundle（默认 profile；-Profile 指定其它）
#   4. skill 复制到 ~/.dsh/skills；MCP 挂载条目写入 profile 用户 patch 层
#
#   工作区注册不在本脚本：装好后 dsh 会话里 /swarm-add 即可
#
# 也支持环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY
# 注意：含中文的 ps1 必须存 UTF-8 带 BOM（PS 5.1 本地执行读 BOM）。

param(
    [string]$Server,
    [string]$ApiKey,
    [string]$Src,
    # 缺省自动探测：桌面版 → desktop profile；CLI 版 → 空（default profile）
    [string]$Profile = ""
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

# dsh CLI 探测顺序：PATH → DeepSeek Harness 桌面版内置（Electron asar，未注册 PATH）
$desktopDsh = Join-Path ${env:LOCALAPPDATA} "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
    $dshBin = $dshCmd.Source
} elseif (Test-Path $desktopDsh) {
    $dshBin = $desktopDsh
    Write-Host "==> 使用桌面版内置 dsh：$desktopDsh"
    # 桌面版固定用 desktop profile（用户没显式指定时）
    if (-not $Profile) { $Profile = "desktop" }
} else {
    Write-Host "错误: 未找到 dsh 命令（PATH 与桌面版默认安装路径均无），请先安装 DeepSeek Harness" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 node（编译插件需要），请先安装 Node.js 22+" -ForegroundColor Red
    exit 1
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 1. 安装 bundle：把插件目录复制到固定位置并 dsh plugin add（本地路径免构建脚本）
$bundleDir = Join-Path $HOME ".dsh\agent-swarm-plugin"
New-Item -ItemType Directory -Force -Path (Join-Path $bundleDir "src") | Out-Null
Copy-Item -Path (Join-Path $Src "package.json") -Destination $bundleDir -Force
Copy-Item -Path (Join-Path $Src "cordis.patch.yml") -Destination $bundleDir -Force
Copy-Item -Path (Join-Path $Src "register.mjs") -Destination $bundleDir -Force
Copy-Item -Path (Join-Path $Src "src\*.ts") -Destination (Join-Path $bundleDir "src") -Force

# dsh 以 tsx 加载源码（源码运行形态），bundle main 指向 js 转发器即可。
# 必须 export *：Loader 读 name/inject/apply 全部具名导出（漏 inject = 服务注入声明失效）。
$forwarder = @"
// 由 install 脚本生成：转发到 TypeScript 源码（dsh 运行时自带 tsx 加载）
export * from "./src/index.ts"
"@
[IO.File]::WriteAllText((Join-Path $bundleDir "index.js"), $forwarder, $utf8NoBom)
$addArgs = @("plugin")
if ($Profile) { $addArgs += @("--profile", $Profile) }
$addArgs += @("add", $bundleDir)
Write-Host "==> dsh $($addArgs -join ' ')（安装 bundle）"
& $dshBin @addArgs
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed（若 pnpm 提示 allowBuilds，按提示把键加入 profile 的 pnpm-workspace.yaml 后重跑）" }

# 2. 写全局配置 + 环境变量层（bundle 的 mcp-client 条目从 process.env 读凭据）
$cfgDir = Join-Path $HOME ".config\dsh"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = @{ serverUrl = $Server; apiKey = $ApiKey } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $cfgDir "agent-swarm.json"), $cfg, $utf8NoBom)
Write-Host "==> 已写配置 $cfgDir\agent-swarm.json"

# ~/.dsh/.env：dsh 启动时加载进 process.env（AGENT_SWARM_SERVER/API_KEY 供 MCP 条目用）
$dshEnv = Join-Path $HOME ".dsh\.env"
$envLines = @{ AGENT_SWARM_SERVER = $Server; AGENT_SWARM_API_KEY = $ApiKey }
$existing = @{}
if (Test-Path $dshEnv) {
    Get-Content $dshEnv | ForEach-Object {
        if ($_ -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$") { $existing[$Matches[1]] = $Matches[2].Trim() }
    }
}
foreach ($k in $envLines.Keys) { $existing[$k] = $envLines[$k] }
$newContent = ($existing.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
New-Item -ItemType Directory -Force -Path (Join-Path $HOME ".dsh") | Out-Null
[IO.File]::WriteAllText($dshEnv, $newContent + "`n", $utf8NoBom)
Write-Host "==> 已更新 $dshEnv（AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY）"

# 2.5 skill：复制到 ~/.dsh/skills（dsh 本地提供方 user-dsh root，rank 400）
$skillSrc = Join-Path $Src "skills"
if (Test-Path $skillSrc) {
    $skillsDir = Join-Path $HOME ".dsh\skills"
    New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
    Copy-Item -Path $skillSrc -Destination $skillsDir -Recurse -Force
    Write-Host "==> 已安装 skill 到 $skillsDir\agent-swarm"
}

# 2.6 MCP 挂载：把解析后的静态条目追加进 profile 用户 patch 层。
# （bundle patch 禁止 !!js——plugin-manager 安装期校验用 js-yaml 默认 schema 不认；
#  用户 patch 层由启动时 Include 解析，但为统一也不写表达式，直接写明文值。）
$profileName = if ($Profile) { $Profile } else { "desktop" }
$profilePatch = Join-Path $HOME ".dsh\profiles\$profileName\cordis.patch.yml"
$mcpUrl = "$Server/mcp/"
$mcpHeader = "Bearer $ApiKey"
$mcpEntry = @"

# agent-swarm MCP（由 install-deepseek 写入；删掉本段即卸载 mcp__agent-swarm__* 工具）
- id: agent-swarm-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: agent-swarm
    transport: streamable-http
    url: $mcpUrl
    headers:
      Authorization: $mcpHeader
    toolCallTimeoutMs: 120000
    failOnStartupError: false
"@
if (Test-Path $profilePatch) {
    $patchText = [IO.File]::ReadAllText($profilePatch)
    if ($patchText -match "agent-swarm-mcp") {
        Write-Host "==> MCP 条目已存在于 $profilePatch（跳过）"
    } else {
        [IO.File]::WriteAllText($profilePatch, $patchText.TrimEnd() + "`n" + $mcpEntry, $utf8NoBom)
        Write-Host "==> 已追加 MCP 挂载到 $profilePatch"
    }
} else {
    [IO.File]::WriteAllText($profilePatch, $mcpEntry.TrimStart() + "`n", $utf8NoBom)
    Write-Host "==> 已创建 $profilePatch（含 MCP 挂载）"
}

# 工作区注册不在安装脚本做：装好插件后，在 dsh 会话里对目标项目执行 /swarm-add 即可
# （dsh 命令天然绑定当前项目目录；register.mjs 仅保留给 /swarm-add 之外的脚本化场景）。
Write-Host "==> 下一步：在 dsh 里打开目标项目的会话，让 agent 执行 /swarm-add 注册工作区"
Write-Host "✅ [deepseek] 安装完成！重启 dsh（dsh web）后插件自动加载：心跳在线、任务落 per-caller 会话。"
