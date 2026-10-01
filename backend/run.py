"""笔灵桌面版后端入口：uvicorn 启动 FastAPI。

- 仅监听 127.0.0.1（本机使用，桌面应用安全性考虑，不对外网暴露）
- log_config=None：不重置 app.main 已配置的 root 文件日志（logging_config.setup_logging）
- 端口由壳层通过 BILING_PORT 环境变量指定（默认 8000）
"""
import os

import uvicorn

from app.main import app

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("BILING_PORT", "8000")),
        log_config=None,
    )
