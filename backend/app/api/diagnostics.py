"""诊断与日志：前端日志收集 + 一键导出（桌面版排查用户机器问题用）。

- POST /api/logs：前端批量上报错误/警告，追加到 data/logs/frontend.log
- GET  /api/diagnostics/export：打包后端日志 + 前端日志 + 系统信息为 zip，
  用户发给作者即可定位问题（导出内容不包含模型 Key，Key 存数据库且从不写日志）
"""
import datetime
import io
import logging
import os
import platform
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.config import get_settings

# 注意：两个端点分别保持自己的完整路径（/api/logs 供前端短路径上报；export 归 diagnostics 命名空间）
router = APIRouter(tags=["diagnostics"])

logger = logging.getLogger(__name__)

# 单条前端日志上限：截断超长内容，防止日志文件被刷爆
_MAX_LINE = 4000
_MAX_BATCH = 200


class LogBatch(BaseModel):
    """前端日志批量上报：lines 为 [{ts, level, msg}]。"""
    lines: list[dict]


@router.post("/api/logs")
def collect_frontend_logs(payload: LogBatch):
    """前端错误/警告批量落盘（data/logs/frontend.log）。"""
    logs_dir = Path(get_settings().resolved_data_dir) / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    target = logs_dir / "frontend.log"
    with open(target, "a", encoding="utf-8") as fh:
        for line in payload.lines[: _MAX_BATCH]:
            ts = str(line.get("ts", ""))
            level = str(line.get("level", "INFO")).upper()
            msg = str(line.get("msg", ""))[:_MAX_LINE]
            fh.write(f"{ts} {level} [frontend] {msg}\n")
    return {"ok": True}


@router.get("/api/diagnostics/export")
def export_logs():
    """打包日志（后端 + 前端）+ 系统信息为一个 zip，供用户发给作者排查。"""
    data_dir = Path(get_settings().resolved_data_dir)
    logs_dir = data_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    candidates = [
        logs_dir / "biling.log",
        logs_dir / "frontend.log",
    ]
    existing = [f for f in candidates if f.exists() and f.stat().st_size > 0]
    if not existing:
        raise HTTPException(404, "暂无日志可导出")

    # 系统信息（帮助作者判断运行环境）
    sys_lines = [
        f"生成时间: {datetime.datetime.now().isoformat(timespec='seconds')}",
        f"系统: {platform.platform()}",
        f"架构: {platform.machine()}",
        f"Python: {platform.python_version()}",
        f"数据目录: {data_dir}",
    ]
    try:
        usage = shutil.disk_usage(data_dir)
        sys_lines.append(f"磁盘可用: {usage.free // (2**30)} GB / 共 {usage.total // (2**30)} GB")
    except OSError:
        pass
    try:
        sys_lines.append(f"CPU 核数: {os.cpu_count() or 0}")
    except Exception:
        pass

    name = f"biling-logs-{datetime.datetime.now():%Y%m%d-%H%M%S}.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("system-info.txt", "\n".join(sys_lines) + "\n")
        for f in existing:
            try:
                z.write(f, arcname=f.name)
            except OSError:
                continue

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
