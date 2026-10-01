"""应用配置：环境变量驱动，LiteLLM 网关直接读取各 provider 的 API Key 环境变量。

桌面版约定：用户数据（数据库、日志、导入文件）统一放 data_dir（默认程序旁的 data 子目录，
由壳层通过 BILING_DATA_DIR 环境变量显式指定）；模型 Key 由「模型」页写入本地 SQLite，
运行时不再依赖 .env。
"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="BILING_", extra="ignore")

    app_name: str = "笔灵 Biling"
    debug: bool = True

    # 用户数据根目录：数据库 / 日志 / 导入文件统一放这里。
    # 桌面版由壳层设为「程序旁 data\」（BILING_DATA_DIR）；开发默认 backend/data\。
    data_dir: str = "./data"

    # 数据库 URL：留空则自动用 <data_dir>/biling.db；显式配置（如 PostgreSQL）则原样使用。
    database_url: str = ""

    # 默认写手模型（model_routes 为空时兜底；配了 Key 即可工作）
    default_writer_model: str = "deepseek/deepseek-chat"
    default_extract_model: str = "deepseek/deepseek-chat"
    default_review_model: str = "deepseek/deepseek-chat"
    default_setting_model: str = "deepseek/deepseek-chat"
    default_chronicle_model: str = "deepseek/deepseek-chat"

    # 未配置任何 API Key 时是否允许 Mock 流式输出（演示模式）。生产/正式使用必须为 False，
    # 未接入模型时 AI 功能直接报错并引导用户去「模型」页配置，而不是静默输出示例。
    allow_mock_without_key: bool = False

    # CORS（前端 Next.js dev 默认 3000）
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # 设定快照注入上限（不可变优先 → 最新优先；设定多的可调大）
    settings_snapshot_limit: int = 100

    # 作品编年生成周期：每 N 章自动触发一次编年师，把早期主线/伏笔压成固定大小的长期记忆注入
    chronicle_generate_every: int = 10

    @property
    def resolved_data_dir(self) -> str:
        """数据根目录（绝对路径）：日志/导入文件都基于它。"""
        return str(Path(self.data_dir).resolve())

    @property
    def resolved_database_url(self) -> str:
        """数据库 URL：未显式配置时自动指向 <data_dir>/biling.db（桌面版零配置）。"""
        if self.database_url:
            return self.database_url
        db_path = (Path(self.data_dir).resolve() / "biling.db").as_posix()
        return f"sqlite:///{db_path}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
