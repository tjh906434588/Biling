"""应用配置：环境变量驱动，LiteLLM 网关直接读取各 provider 的 API Key 环境变量。"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="BILING_", extra="ignore")

    app_name: str = "笔灵 Biling"
    debug: bool = True

    # SQLite 开发兜底；部署切 PostgreSQL（见 technical-design §2）
    database_url: str = "sqlite:///./biling.db"

    # 默认写手模型（model_routes 为空时兜底；配了 Key 即可工作）
    default_writer_model: str = "deepseek/deepseek-chat"
    default_extract_model: str = "deepseek/deepseek-chat"
    default_review_model: str = "deepseek/deepseek-chat"
    default_chat_model: str = "deepseek/deepseek-chat"
    default_setting_model: str = "deepseek/deepseek-chat"

    # 未配置任何 API Key 时是否允许 Mock 流式输出（演示模式）。生产/正式使用必须为 False，
    # 未接入模型时 AI 功能直接报错并引导用户去「模型」页配置，而不是静默输出示例。
    allow_mock_without_key: bool = False

    # CORS（前端 Next.js dev 默认 3000）
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # 设定快照注入上限（不可变优先 → 最新优先；设定多的可调大）
    settings_snapshot_limit: int = 100


@lru_cache
def get_settings() -> Settings:
    return Settings()
