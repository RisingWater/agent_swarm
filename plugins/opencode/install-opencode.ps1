# agent_swarm opencode 插件安装子脚本（由 deploy\install.ps1 分发器调用）。
# 分发器已把插件包解压到 -Src（即本脚本所在目录），本脚本只做本地注册：
#   1. 链接/安装依赖            2. 写入 config.json
#   3. 注册 mcp.agent-swarm     4. 注册插件（心跳保活）
#   5. 安装 /swarm-* 命令
#
# 也支持环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

param(
    [string]$Server,
    [string]$ApiKey,
    [string]$Src,
    [string]$InstallDir = (Join-Path $HOME ".config\opencode\plugins\agent-swarm"),
    [switch]$Global
)

$ErrorActionPreference = "Stop"

# 剥 JSONC 注释（字符串感知：file:// 等字符串内的 // 不是注释）
function Remove-JsoncComment {
    param([string]$Text)
    $sb = [System.Text.StringBuilder]::new()
    $inStr = $false; $inLine = $false; $inBlock = $false
    $i = 0
    while ($i -lt $Text.Length) {
        $c = $Text[$i]
        $n = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }
        if ($inLine) {
            if ($c -eq "`n") { $inLine = $false; [void]$sb.Append($c) }
            $i++; continue
        }
        if ($inBlock) {
            if ($c -eq "*" -and $n -eq "/") { $inBlock = $false; [void]$sb.Append(" "); $i += 2; continue }
            $i++; continue
        }
        if ($inStr) {
            [void]$sb.Append($c)
            if ($c -eq "\") { [void]$sb.Append($n); $i += 2; continue }
            if ($c -eq '"') { $inStr = $false }
            $i++; continue
        }
        if ($c -eq '"') { $inStr = $true; [void]$sb.Append($c); $i++; continue }
        if ($c -eq "/" -and $n -eq "/") { $inLine = $true; $i += 2; continue }
        if ($c -eq "/" -and $n -eq "*") { $inBlock = $true; $i += 2; continue }
        [void]$sb.Append($c)
        $i++
    }
    return $sb.ToString()
}

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
if (-not (Test-Path (Join-Path $Src "package.json"))) {
    Write-Host "错误: 插件源目录无效（缺 package.json）: $Src" -ForegroundColor Red
    exit 1
}

Write-Host "==> [opencode] 安装插件"
Write-Host "    服务器: $Server"
Write-Host "    目录:   $InstallDir"

# 1. 复制插件文件到安装目录（源目录来自分发包，保持其只读）
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $Src "*") -Destination $InstallDir -Recurse -Force

# 2. 安装依赖（复用 opencode 全局已有的 @opencode-ai/*，避免重复下载）
Write-Host "==> 安装依赖..."
$candidates = @()
$ocCmd = Get-Command opencode -ErrorAction SilentlyContinue
if ($ocCmd) {
    # npm 全局布局: <install-root>\lib\node_modules\opencode-ai\node_modules
    $candidates += Join-Path (Split-Path (Split-Path $ocCmd.Source)) "lib\node_modules\opencode-ai\node_modules"
}
$candidates += @(
    (Join-Path $HOME ".config\opencode\node_modules"),
    (Join-Path $env:APPDATA "npm\node_modules\opencode-ai\node_modules")
)
$ocNm = ""
foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c "@opencode-ai"))) { $ocNm = $c; break }
}

if ($ocNm) {
    Write-Host "    复用 opencode 依赖: $ocNm"
    $link = Join-Path $InstallDir "node_modules"
    if (-not (Test-Path $link)) {
        # Junction 不需要管理员权限（SymbolicLink 需要）
        try { New-Item -ItemType Junction -Path $link -Target $ocNm | Out-Null } catch {}
    }
}

if (-not (Test-Path (Join-Path $InstallDir "node_modules\@opencode-ai"))) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "错误: 需要 npm（opencode 依赖），请先安装 Node.js" -ForegroundColor Red
        exit 1
    }
    Push-Location $InstallDir
    try { & npm install --no-audit --no-fund --loglevel=error } finally { Pop-Location }
}

# 3. 写入本机插件配置（server + apikey + 执行模式）
#    plugins/agent-swarm/config.json 与 loadConfig() 实际读取的
#    ~/.config/opencode/agent-swarm.json 都写，避免路径不一致导致插件拿不到 key。
#    executionMode 已有人工设置时不覆盖（幂等重装保留用户选择）
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-PluginConfig {
    param([string]$Path)
    if ((Test-Path $Path) -and ((Get-Content $Path -Raw) -match '"executionMode"')) {
        $cfg = Get-Content $Path -Raw | ConvertFrom-Json
        $cfg.serverUrl = $Server
        $cfg.apiKey = $ApiKey
        [IO.File]::WriteAllText($Path, ($cfg | ConvertTo-Json), $utf8NoBom)
    } else {
        $cfg = @{
            serverUrl = $Server
            apiKey = $ApiKey
            executionMode = "foreground"
            backgroundCommand = "auto"
        } | ConvertTo-Json
        [IO.File]::WriteAllText($Path, $cfg, $utf8NoBom)
    }
}
Write-PluginConfig (Join-Path $InstallDir "config.json")
Write-PluginConfig (Join-Path $HOME ".config\opencode\agent-swarm.json")

# 4. 注册：a) mcp.agent-swarm 配置（工具直连 MCP）b) 插件（心跳保活）
$hasLocal = (Test-Path (Join-Path $PWD "opencode.json")) -or (Test-Path (Join-Path $PWD "opencode.jsonc"))
if ($Global -or -not $hasLocal) {
    $ocConfig = Join-Path $HOME ".config\opencode\opencode.jsonc"
    if (Test-Path (Join-Path $HOME ".config\opencode\opencode.json")) {
        $ocConfig = Join-Path $HOME ".config\opencode\opencode.json"
    }
} else {
    $ocConfig = Join-Path $PWD "opencode.jsonc"
    if (Test-Path (Join-Path $PWD "opencode.json")) { $ocConfig = Join-Path $PWD "opencode.json" }
}

New-Item -ItemType Directory -Force -Path (Split-Path $ocConfig) | Out-Null
$text = ""
if (Test-Path $ocConfig) { $text = [IO.File]::ReadAllText($ocConfig) }

# opencode 配置读改写：JSONC 剥注释 → JSON.parse → 对象操作 → stringify 整体重写。
# （曾用正则/索引手术改写，第二次运行时尾部锚点误配 headers 内层 }，写出缺 } 的坏 JSON
#  导致 opencode 拒绝启动——JSON 往返重写从根上杜绝，重写后注释会丢，但配置文件注释本就非契约。）
$mcpEntry = @{ type = "remote"; url = "$Server/mcp/"; enabled = $true; headers = @{ Authorization = "Bearer $ApiKey" } }
function Update-OpencodeConfig {
    param([string]$Path, [string]$Json)
    if (-not (Test-Path $Path)) { return $false }
    try {
        $stripped = Remove-JsoncComment -Text ([IO.File]::ReadAllText($Path))
        $cfg = $stripped | ConvertFrom-Json
        $mcp = $cfg.mcp
        if ($null -eq $mcp) { return $false }
        $mcp | Add-Member -NotePropertyName "agent-swarm" -NotePropertyValue $mcpEntry -Force
        [IO.File]::WriteAllText($Path, ($cfg | ConvertTo-Json -Depth 20), $utf8NoBom)
        return $true
    } catch {
        Write-Host "警告: $Path 解析失败（$($_.Exception.Message)），跳过 MCP 刷新" -ForegroundColor Yellow
        return $false
    }
}

$updated = Update-OpencodeConfig -Path $ocConfig -Json $text
if ($updated) {
    Write-Host "==> 已更新 mcp.agent-swarm（URL/apikey 刷新）"
} else {
    # 无 mcp 字段或解析失败且文件不存在/为空：安全插入最小 mcp 块（对象式构造，不会产出坏 JSON）
    $cfg = @{ mcp = @{ "agent-swarm" = $mcpEntry } }
    if ($text.Trim()) {
        try {
            $existing = (Remove-JsoncComment -Text $text) | ConvertFrom-Json
            $existing | Add-Member -NotePropertyName "mcp" -NotePropertyValue $cfg.mcp -Force
            [IO.File]::WriteAllText($ocConfig, ($existing | ConvertTo-Json -Depth 20), $utf8NoBom)
            Write-Host "==> 已写入 mcp.agent-swarm 到 $ocConfig"
        } catch {
            Write-Host "错误: $ocConfig 不是合法 JSON(C)，请手工修正后重跑安装（不会覆盖你的文件）" -ForegroundColor Red
            exit 1
        }
    } else {
        [IO.File]::WriteAllText($ocConfig, ($cfg | ConvertTo-Json -Depth 20), $utf8NoBom)
        Write-Host "==> 已创建 $ocConfig 并写入 mcp.agent-swarm"
    }
}

# 插件（file:// 指向入口）负责心跳保活
$pluginRef = "file:///" + ($InstallDir -replace "\\", "/") + "/src/index.ts"

function Add-PluginRef {
    param([string]$Path, [string]$Ref)
    $read = ""
    if (Test-Path $Path) { $read = [IO.File]::ReadAllText($Path) }
    if ($read -and $read.Contains($Ref)) {
        Write-Host "==> 插件已在配置中，跳过注册（$Path）"
        return
    }
    $cfg = @{}
    if ($read.Trim()) {
        try {
            $cfg = (Remove-JsoncComment -Text $read) | ConvertFrom-Json
        } catch {
            Write-Host "警告: $Path 解析失败，跳过插件注册（$($_.Exception.Message)）" -ForegroundColor Yellow
            return
        }
    }
    if ($null -eq $cfg.plugin) {
        $cfg | Add-Member -NotePropertyName "plugin" -NotePropertyValue @($Ref) -Force
    } elseif ($cfg.plugin -is [array]) {
        $cfg.plugin = @($cfg.plugin) + @($Ref)
    } else {
        $cfg.plugin = @($cfg.plugin, $Ref)
    }
    [IO.File]::WriteAllText($Path, ($cfg | ConvertTo-Json -Depth 20), $utf8NoBom)
    Write-Host "==> 已注册插件到 $Path"
}
Add-PluginRef -Path $ocConfig -Ref $pluginRef

# TUI 插件注册到 ~/.config/opencode/tui.jsonc（v1 TUI 插件与 server 插件分开注册）
$tuiCfg = Join-Path $HOME ".config\opencode\tui.jsonc"
$tuiRef = "file:///" + ($InstallDir -replace "\\", "/") + "/src/tui.ts"
if (-not (Test-Path $tuiCfg)) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($tuiCfg)) | Out-Null
    $tuiCfgObj = @{ plugin = @($tuiRef) } | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($tuiCfg, $tuiCfgObj, $utf8NoBom)
    Write-Host "==> 已创建并注册 TUI 插件到 $tuiCfg"
} else {
    Add-PluginRef -Path $tuiCfg -Ref $tuiRef
}

# 5. 安装 md 命令（/swarm-add：前台会话由 agent 生成 purpose 后调 MCP 工具）
$cmdDir = Join-Path $HOME ".config\opencode\commands"
New-Item -ItemType Directory -Force -Path $cmdDir | Out-Null

Copy-Item (Join-Path $Src "commands\swarm-add.md") (Join-Path $cmdDir "swarm-add.md") -Force
Write-Host "==> 已安装 /swarm-add 命令"

# 6. 清理已废弃的 md 命令（/swarm-* 其余为 TUI 原生命令，见 src/tui.ts；swarm-register 已废弃）
foreach ($old in @("swarm-note", "swarm-desc", "swarm-resummarize", "swarm_register", "swarm",
                   "swarm-remove", "swarm-enable", "swarm-disable", "swarm-register", "swarm-mode")) {
    $f = Join-Path $cmdDir "$old.md"
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host "    已移除旧命令 /$old" }
}

Write-Host "✅ [opencode] 安装完成！重启 opencode 后：MCP 工具可用，插件自动心跳保活，/swarm-* 命令就绪。"
