# agent_swarm 插件分发安装器（Windows PowerShell 5.1+，对应 install.sh 的 Windows 版）。
# 下载分发包（含所有 agent 插件），逐个执行各插件的 install-*.ps1 安装子脚本。
# 典型用法（在管理页面复制完整命令）:
#   & ([scriptblock]::Create((irm http://<server>/download/install.ps1))) -ApiKey as_xxx
#
# 手动下载后请勿直接运行（本文件必须保持 UTF-8 无 BOM 才能被 5.1 正确解析），
# 一律用上面的一键命令。
#
# 可选: -Only opencode,claude  只装指定插件（缺省全装）
# 也支持环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

param(
    [string]$Server,
    [string]$ApiKey,
    [string]$Only
)

$ErrorActionPreference = "Stop"

# 服务地址解析顺序：-Server 参数 > 环境变量 > 服务端注入的占位符。
# __SERVER_URL__ 由服务端对整个文件做文本替换；替换后它不再是占位符。
# 校验不能拿「是否等于占位符」（字面量也会被替换，导致恒真/恒假），
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

# 0. 前置检查
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    Write-Host "错误: 未找到 tar.exe（需要 Windows 10 1803+ 或手动解压插件包）" -ForegroundColor Red
    exit 1
}

# 1. 下载并解压分发包（内含 plugins/ 下各 agent 插件目录 + 安装子脚本）
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("swarm-" + [IO.Path]::GetRandomFileName())
try {
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Write-Host "==> 下载插件包..."
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/download/plugin.tar.gz" -OutFile (Join-Path $tmp "plugins.tar.gz")
    New-Item -ItemType Directory -Force -Path (Join-Path $tmp "dist") | Out-Null
    & tar.exe -xzf (Join-Path $tmp "plugins.tar.gz") -C (Join-Path $tmp "dist")
    if ($LASTEXITCODE -ne 0) { throw "tar 解压失败 (exit $LASTEXITCODE)" }
    $pluginsDir = Join-Path $tmp "dist\plugins"
    if (-not (Test-Path $pluginsDir)) {
        # 兼容旧包（plugin/ 单插件布局）
        $pluginsDir = Join-Path $tmp "dist\plugins"
        New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
        Move-Item (Join-Path $tmp "dist\plugin") (Join-Path $pluginsDir "opencode")
    }

    # 2. 遍历 plugins/ 下每个插件目录，执行其 install-*.ps1
    $want = @()
    if ($Only) { $want = $Only.Split(",") | ForEach-Object { $_.Trim() } }
    $failed = 0
    Get-ChildItem $pluginsDir -Directory | ForEach-Object {
        $name = $_.Name
        if ($want.Count -gt 0 -and $want -notcontains $name) {
            Write-Host "==> 跳过 $name（-Only 未包含）"
            return
        }
        $script = $null
        foreach ($f in @("install-$name.ps1", "install.ps1")) {
            $p = Join-Path $_.FullName $f
            if (Test-Path $p) { $script = $p; break }
        }
        if (-not $script) {
            Write-Host "==> 跳过 $name（无安装脚本）"
            return
        }
        Write-Host ""
        Write-Host "======== 安装 $name ========"
        try {
            & $script -Server $Server -ApiKey $ApiKey -Src $_.FullName
        } catch {
            Write-Host "⚠️  $name 安装失败: $_（继续安装其余插件）" -ForegroundColor Yellow
            $failed = 1
        }
    }

    Write-Host ""
    if ($failed -eq 0) {
        Write-Host "✅ 全部插件安装完成！"
    } else {
        Write-Host "✅ 安装完成（部分插件失败，见上方日志）"
    }
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
