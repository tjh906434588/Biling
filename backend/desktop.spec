# -*- mode: python ; coding: utf-8 -*-
"""笔灵后端 PyInstaller 打包配置（onedir）。

在 backend/ 目录下执行：
    pyinstaller --noconfirm desktop.spec
产物：backend/dist/backend/backend.exe + backend/dist/backend/_internal/

桌面版壳层（Electron）以 resources/backend/backend.exe 方式拉起它；
数据目录由壳层通过 BILING_DATA_DIR 环境变量指定（程序旁 data\）。
"""
from PyInstaller.utils.hooks import collect_all

block_cipher = None

# litellm 依赖链存在大量动态导入与数据文件（tiktoken 编码、tokenizers 二进制等），
# 用 collect_all 全量收集最稳，代价是体积偏大（可接受）。
datas: list = []
binaries: list = []
hiddenimports: list = []
for _pkg in ("litellm", "tiktoken", "tokenizers"):
    try:
        _d, _b, _h = collect_all(_pkg)
        datas += _d
        binaries += _b
        hiddenimports += _h
    except Exception:
        pass

a = Analysis(
    ["run.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "test", "unittest", "pydoc_data", "email"],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# console=False：桌面版不弹黑色终端窗口（日志已落盘 data/logs/biling.log）
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="backend",
)
