"""统一日志配置：控制台 + 文件轮转（data/logs/biling.log）。

桌面版日志落盘是排查用户机器问题的基础：壳层把前后端日志都收集到 data/logs/，
用户通过「导出日志」打包发给作者即可定位问题（见 app/api/diagnostics.py）。
"""
import logging
import logging.handlers
from pathlib import Path

_LOG_FILE_NAME = "biling.log"


def setup_logging(data_dir: Path | str, *, level: int = logging.INFO) -> Path:
    """给根 logger 挂上控制台 + 文件轮转 handler，返回日志文件路径。

    - 文件：data/logs/biling.log，2MB × 5 轮转，UTF-8 编码
    - 幂等：重复调用不会叠加 handler（热重载/多次导入安全）
    - 调用方若以 uvicorn.run(log_config=None) 启动（见 run.py），uvicorn 不会重置
      root handlers，文件日志在桌面版里稳定生效；纯 uvicorn CLI 开发模式仅控制台。
    """
    logs_dir = Path(data_dir) / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_file = logs_dir / _LOG_FILE_NAME

    fmt = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")

    root = logging.getLogger()
    root.setLevel(level)

    # 清理已挂的 handler，避免热重载/重复导入叠加
    for h in list(root.handlers):
        root.removeHandler(h)

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    file_handler = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=2 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    # uvicorn 的 access/error logger 交给 root 处理（统一进文件 + 控制台）
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True

    return log_file
