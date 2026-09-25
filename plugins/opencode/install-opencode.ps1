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

# 探测 opencode 版本：major >= 2 用 V2 插件（全新插件 API），否则 V1（老 API）
$ocVer = ""
try { $ocVer = (& opencode --version 2>$null | Select-Object -First 1) } catch {}
$ocMajor = 0
if ("$ocVer" -match '(\d+)') { $ocMajor = [int]$Matches[1] }
if ($ocMajor -ge 2) { $OcMode = "v2" } else { $OcMode = "v1" }
Write-Host "==> [opencode] 版本: $(if ($ocVer) { $ocVer } else { '未知' }) → 安装 $OcMode 插件"

Write-Host "==> [opencode] 安装插件"
Write-Host "    服务器: $Server"
Write-Host "    目录:   $InstallDir"

# 1. 复制插件文件到安装目录（源目录来自分发包，保持其只读）
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $Src "*") -Destination $InstallDir -Recurse -Force

# 2. 依赖：只有 V1 插件需要 @opencode-ai/*（V2 插件自包含，无运行时裸依赖）
if ($OcMode -eq "v1") {
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
} else {
    Write-Host "==> V2 插件自包含（无运行时裸依赖），跳过依赖安装"
    $nm = Join-Path $InstallDir "node_modules"
    if (Test-Path $nm) { Remove-Item $nm -Recurse -Force -ErrorAction SilentlyContinue }
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
$mcpEntry = if ($OcMode -eq "v2") {
    # V2：MCP 服务器在 mcp.servers[] 下（用 disabled 反向；省略 = 启用）
    @{ type = "remote"; url = "$Server/mcp/"; headers = @{ Authorization = "Bearer $ApiKey" } }
} else {
    @{ type = "remote"; url = "$Server/mcp/"; enabled = $true; headers = @{ Authorization = "Bearer $ApiKey" } }
}

# 把 agent-swarm 写入配置：V1 写 mcp["agent-swarm"]，V2 写 mcp.servers["agent-swarm"] 并清掉扁平条目
function Set-SwarmMcp {
    param($Cfg)
    if ($null -eq $Cfg.mcp) {
        $Cfg | Add-Member -NotePropertyName "mcp" -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($OcMode -eq "v2") {
        if ($Cfg.mcp.PSObject.Properties.Name -contains "agent-swarm") {
            $Cfg.mcp.PSObject.Properties.Remove("agent-swarm")
        }
        if ($null -eq $Cfg.mcp.servers) {
            $Cfg.mcp | Add-Member -NotePropertyName "servers" -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        if ($Cfg.mcp.servers.PSObject.Properties.Name -contains "agent-swarm") {
            $Cfg.mcp.servers.PSObject.Properties.Remove("agent-swarm")
        }
        $Cfg.mcp.servers | Add-Member -NotePropertyName "agent-swarm" -NotePropertyValue $mcpEntry -Force
    } else {
        if ($Cfg.mcp.PSObject.Properties.Name -contains "servers" -and $Cfg.mcp.servers.PSObject.Properties.Name -contains "agent-swarm") {
            $Cfg.mcp.servers.PSObject.Properties.Remove("agent-swarm")
        }
        $Cfg.mcp | Add-Member -NotePropertyName "agent-swarm" -NotePropertyValue $mcpEntry -Force
    }
    return $Cfg
}

if (Test-Path $ocConfig) {
    try {
        $cfg = (Remove-JsoncComment -Text $text) | ConvertFrom-Json
        $cfg = Set-SwarmMcp -Cfg $cfg
        [IO.File]::WriteAllText($ocConfig, ($cfg | ConvertTo-Json -Depth 20), $utf8NoBom)
        if ($OcMode -eq "v2") { Write-Host "==> 已写入 mcp.servers.agent-swarm 到 $ocConfig（V2）" }
        else { Write-Host "==> 已更新 mcp.agent-swarm 到 $ocConfig（V1）" }
    } catch {
        Write-Host "错误: $ocConfig 不是合法 JSON(C)（$($_.Exception.Message)），不覆盖，请手工修正后重跑安装" -ForegroundColor Red
        exit 1
    }
} else {
    $cfg = [pscustomobject]@{}
    $cfg = Set-SwarmMcp -Cfg $cfg
    [IO.File]::WriteAllText($ocConfig, ($cfg | ConvertTo-Json -Depth 20), $utf8NoBom)
    Write-Host "==> 已创建 $ocConfig 并写入 mcp（$OcMode）"
}

# V2：清理配置里指向本插件目录的旧条目（V1 式 file:// 文件路径在 V2 会被忽略并告警；
# V2 靠自动发现加载 <config>\plugins\<name>\index.ts + tui.ts，无需写配置条目）
function Remove-SwarmPluginRefs {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    $read = [IO.File]::ReadAllText($Path)
    if (-not $read.Trim()) { return }
    try { $cfg = (Remove-JsoncComment -Text $read) | ConvertFrom-Json } catch { return }
    $norm = ($InstallDir -replace "\\", "/")
    $changed = $false
    foreach ($key in @("plugin", "plugins")) {
        $val = $cfg.$key
        if ($null -eq $val) { continue }
        $kept = @()
        foreach ($item in @($val)) {
            $s = if ($item -is [string]) { $item } elseif ($item -and $item.package) { "$($item.package)" } else { "" }
            if ($s -and (($s -replace "\\", "/") -like "*$norm*")) { $changed = $true } else { $kept += $item }
        }
        if ($kept.Count -eq 0) { $cfg.PSObject.Properties.Remove($key) }
        else { $cfg | Add-Member -NotePropertyName $key -NotePropertyValue @($kept) -Force }
    }
    if ($changed) {
        [IO.File]::WriteAllText($Path, ($cfg | ConvertTo-Json -Depth 20), $utf8NoBom)
        Write-Host "==> 已从 $Path 清理指向本插件的旧条目"
    }
}

if ($OcMode -eq "v1") {
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
} else {
    Remove-SwarmPluginRefs -Path $ocConfig
    Remove-SwarmPluginRefs -Path (Join-Path $HOME ".config\opencode\tui.jsonc")
    Write-Host "==> V2 插件随 opencode 启动自动加载（无需配置条目）"
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

Write-Host "✅ [opencode] 安装完成（$OcMode 插件）！重启 opencode 后：MCP 工具可用，插件自动心跳保活，/swarm-* 命令就绪。"
