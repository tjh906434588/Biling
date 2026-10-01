"""数据库会话管理（开发期 SQLite 兜底，部署切 PostgreSQL，代码零改动）。

数据目录约定：SQLite 文件与日志统一放 settings.resolved_data_dir（桌面版 = 程序旁的 data 子目录，
由壳层 BILING_DATA_DIR 指定），首次启动自动建目录；旧版开发库 backend/biling.db 自动迁移。
"""
import shutil
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# 数据目录必须存在（SQLite 不会自动建父目录）
data_dir = Path(settings.resolved_data_dir)
data_dir.mkdir(parents=True, exist_ok=True)

database_url = settings.resolved_database_url

# 旧版开发库迁移：data 下还没有库但 backend/biling.db 存在时，一次性复制过去，避免开发数据"消失"
if database_url.startswith("sqlite:///"):
    db_path = Path(database_url.removeprefix("sqlite:///"))
    legacy = Path("biling.db")
    if not db_path.exists() and legacy.exists() and legacy.resolve() != db_path.resolve():
        shutil.copy2(legacy, db_path)

# SQLite 需要 check_same_thread=False 以配合 FastAPI 异步线程池
engine_kwargs: dict = {}
if database_url.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(database_url, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    """FastAPI 依赖：请求级会话。"""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
