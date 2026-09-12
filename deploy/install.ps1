# agent_swarm opencode 插件安装脚本（Windows PowerShell 5.1+）
# 典型用法（在管理页面复制完整命令）:
#   & ([scriptblock]::Create((irm http://<server>/download/install.ps1))) -ApiKey as_xxx
# 手动下载后请勿直接运行（本文件必须保持 UTF-8 无 BOM 才能被 5.1 正确解析），
# 一律用上面的一键命令。
#
# 也支持环境变量: AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

param(
    [string]$Server,
    [string]$ApiKey,
    [string]$InstallDir = (Join-Path $HOME ".config\opencode\plugins\agent-swarm"),
    [switch]$Global
)

$ErrorActionPreference = "Stop"

# 服务地址解析顺序：-Server 参数 > 环境变量 > 服务端注入的占位符
# __SERVER_URL__ 由服务端对整个文件做文本替换；替换后它不再是占位符。
# 校验不能用"是否等于占位符"（字面量也会被替换，导致恒真/恒假），
# 改为校验最终值是否形如 URL（含 ://）。
if (-not $Server) { $Server = $env:AGENT_SWARM_SERVER }
if (-not $Server) { $Server = "__SERVER_URL__" }
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

# 老系统 https 需要 TLS 1.2
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

Write-Host "==> agent_swarm 插件安装"
Write-Host "    服务器: $Server"
Write-Host "    目录:   $InstallDir"

# 0. 前置检查
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 tar.exe（需要 Windows 10 1803+ 或手动解压插件包）" -ForegroundColor Red
    exit 1
}

# 1. 下载并解压插件包
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("swarm-" + [IO.Path]::GetRandomFileName())
try {
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Write-Host "==> 下载插件包..."
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/download/plugin.tar.gz" -OutFile (Join-Path $tmp "plugin.tar.gz")
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    & tar.exe -xzf (Join-Path $tmp "plugin.tar.gz") -C $InstallDir
    if ($LASTEXITCODE -ne 0) { throw "tar 解压失败 (exit $LASTEXITCODE)" }

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

    # 3. 写入本机插件配置（server + apikey）
    #    plugins/agent-swarm/config.json 与 loadConfig() 实际读取的
    #    ~/.config/opencode/agent-swarm.json 都写，避免路径不一致导致插件拿不到 key
    $cfg = @{ serverUrl = $Server; apiKey = $ApiKey } | ConvertTo-Json
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $InstallDir "config.json"), $cfg, $utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $HOME ".config\opencode\agent-swarm.json"), $cfg, $utf8NoBom)

    # 4. 注册：a) mcp.agent-swarm 配置（工具直连 MCP）b) 插件（心跳保活）
    $mcpBlock = @"
    "agent-swarm": {
      "type": "remote",
      "url": "$Server/mcp/",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer $ApiKey"
      }
    }
"@
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

    if ($text.Contains("$Server/mcp/")) {
        Write-Host "==> mcp.agent-swarm 已配置，跳过"
    } else {
        $m = [regex]::Match($text, '(?s)("mcp"\s*:\s*\{)(.*?)(\n  \})')
        if ($m.Success) {
            $inner = $m.Groups[2].Value
            $stripped = ($inner -replace "//[^\r\n]*", "" -replace "/\*[\s\S]*?\*/", "").Trim()
            $needComma = ($stripped.Length -gt 0) -and (-not $stripped.EndsWith(","))
            if ($needComma) {
                $newInner = $inner.TrimEnd() + ",`n" + $mcpBlock
            } else {
                $newInner = $inner + "`n" + $mcpBlock
            }
            $text = $text.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + $newInner + $m.Groups[3].Value)
        } else {
            $insert = "{`n  `"mcp`": {`n" + $mcpBlock + "`n  },`n"
            $rx = New-Object System.Text.RegularExpressions.Regex("(?m)^\s*\{")
            $newText = $rx.Replace($text, $insert, 1)
            if ($newText -eq $text) { $text = $insert + $text } else { $text = $newText }
        }
        [IO.File]::WriteAllText($ocConfig, $text, $utf8NoBom)
        Write-Host "==> 已写入 mcp.agent-swarm 到 $ocConfig"
    }

    # 插件（file:// 指向入口）负责心跳保活
    $pluginRef = "file:///" + ($InstallDir -replace "\\", "/") + "/src/index.ts"

    New-Item -ItemType Directory -Force -Path (Split-Path $ocConfig) | Out-Null
    $text = ""
    if (Test-Path $ocConfig) { $text = [IO.File]::ReadAllText($ocConfig) }

    if ($text.Contains($pluginRef)) {
        Write-Host "==> 插件已在配置中，跳过注册"
    } else {
        $m = [regex]::Match($text, '(?s)("plugin"\s*:\s*\[)(.*?)(\])')
        if ($m.Success) {
            # 在 plugin 数组中插入新项：逗号插在最后一个非空非注释项的末尾
            $inner = $m.Groups[2].Value
            $stripped = ($inner -replace "//[^\r\n]*", "" -replace "/\*[\s\S]*?\*/", "").Trim()
            $needComma = ($stripped.Length -gt 0) -and (-not $stripped.EndsWith(","))
            if ($needComma) {
                $newInner = $inner.TrimEnd() + ",`n    `"$pluginRef`"`n  "
            } else {
                $newInner = $inner + "`n    `"$pluginRef`"`n  "
            }
            $text = $text.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + $newInner + $m.Groups[3].Value)
        } else {
            # 没有 plugin 字段：插到最外层 { 后（保留 ], 后逗号——其后还有其他字段，合法）
            $insert = "{`n  `"plugin`": [`n    `"$pluginRef`"`n  ],`n"
            $rx = New-Object System.Text.RegularExpressions.Regex("(?m)^\s*\{")
            $newText = $rx.Replace($text, $insert, 1)
            if ($newText -eq $text) { $text = $insert + $text } else { $text = $newText }
        }
        [IO.File]::WriteAllText($ocConfig, $text, $utf8NoBom)
        Write-Host "==> 已注册插件到 $ocConfig"
    }

    # 5. 注册自定义命令（markdown 源文件在 plugin/commands/，拷贝即安装）
    $cmdDir = Join-Path $HOME ".config\opencode\commands"
    New-Item -ItemType Directory -Force -Path $cmdDir | Out-Null

    # 旧版命令文件清理（已被 /swarm-* 取代）
    foreach ($old in @("swarm-note", "swarm-desc", "swarm-resummarize", "swarm_register", "swarm")) {
        $f = Join-Path $cmdDir "$old.md"
        if (Test-Path $f) { Remove-Item $f -Force; Write-Host "    已移除旧命令 /$old" }
    }

    Get-ChildItem (Join-Path $InstallDir "commands") -Filter "swarm-*.md" -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $cmdDir $_.Name) -Force
        Write-Host "    已注册命令 /$($_.BaseName)"
    }

    Write-Host ""
    Write-Host "✅ 安装完成！"
    Write-Host "   重启 opencode 后：MCP 工具（workspace_* 等）直接可用；插件自动心跳保活。"
    Write-Host "   自定义命令: /swarm-add /swarm-register /swarm-remove /swarm-enable /swarm-disable"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
