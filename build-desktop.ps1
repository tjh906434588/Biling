# ============================================================
# 笔灵 Biling 桌面版一键打包脚本（Windows）
# 产物：dist-desktop\Biling-<version>-win.zip（绿色版，解压即用）
#
# 前置：Node.js 22+；后端依赖已安装（backend\.venv 或系统 Python 均可）
# 用法：右键「使用 PowerShell 运行」，或在仓库根目录执行  .\build-desktop.ps1
# 提示：版本号在 desktop\package.json 的 "version" 字段，发版前记得改
# ============================================================
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ---------- [1/4] 后端：PyInstaller ----------
Write-Host "[1/4] 打包后端 ..." -ForegroundColor Cyan
$py = "$root\backend\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
Push-Location "$root\backend"
& $py -m pip install -q pyinstaller
if ($LASTEXITCODE -ne 0) { throw "安装 pyinstaller 失败" }
& $py -m PyInstaller --noconfirm desktop.spec
if ($LASTEXITCODE -ne 0) { throw "后端打包失败（PyInstaller）" }
Pop-Location
New-Item -ItemType Directory -Force -Path "$root\build\backend" | Out-Null
Copy-Item -Recurse -Force "$root\backend\dist\backend\*" "$root\build\backend\"

# ---------- [2/4] 前端：Next standalone ----------
Write-Host "[2/4] 打包前端 ..." -ForegroundColor Cyan
Push-Location "$root\frontend"
if (-not (Test-Path node_modules)) { npm install }
npm run build
if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
# standalone 需要 static（与 public，若有）一并携带
Copy-Item -Recurse -Force .next\static .next\standalone\.next\static
if (Test-Path public) { Copy-Item -Recurse -Force public .next\standalone\public }
New-Item -ItemType Directory -Force -Path "$root\build\server" | Out-Null
Copy-Item -Recurse -Force .next\standalone\* "$root\build\server\"
Pop-Location

# ---------- [3/4] Node 运行时（Next standalone 需要；已存在则跳过） ----------
Write-Host "[3/4] 准备 Node 运行时 ..." -ForegroundColor Cyan
if (-not (Test-Path "$root\build\node\node.exe")) {
  $ver = "v22.14.0"
  $zip = "node-$ver-win-x64.zip"
  Write-Host "    下载 Node $ver ..."
  Invoke-WebRequest "https://nodejs.org/dist/$ver/$zip" -OutFile "$root\$zip"
  Expand-Archive "$root\$zip" -DestinationPath "$root\node_extract"
  New-Item -ItemType Directory -Force -Path "$root\build\node" | Out-Null
  Copy-Item "$root\node_extract\node-$ver-win-x64\node.exe" "$root\build\node\"
  Remove-Item -Recurse -Force "$root\node_extract", "$root\$zip"
} else {
  Write-Host "    已存在，跳过下载"
}

# ---------- [4/4] 桌面壳：electron-builder zip ----------
Write-Host "[4/4] 打包桌面壳 ..." -ForegroundColor Cyan
Push-Location "$root\desktop"
if (-not (Test-Path node_modules)) { npm install }
npx electron-builder --win zip
if ($LASTEXITCODE -ne 0) { throw "桌面壳打包失败（electron-builder）" }
Pop-Location

# ---------- 汇总 ----------
Write-Host ""
Write-Host "完成！产物如下：" -ForegroundColor Green
Get-ChildItem "$root\dist-desktop\*.zip" | ForEach-Object {
  Write-Host "  $($_.FullName)  ($([math]::Round($_.Length / 1MB, 1)) MB)" -ForegroundColor Green
}
Write-Host "提示：解压即用；数据保存在解压目录下的 data\ 文件夹，升级覆盖解压不丢数据。" -ForegroundColor Yellow
