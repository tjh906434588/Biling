"""模型路由：按任务类型解析目标模型（model_routes 存库可改，改配置不加代码）。"""
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AppPreference, ModelRoute

settings = get_settings()

# 任务类型 → 默认模型名（model_routes 为空时的兜底）
_DEFAULT_TASK_MODELS: dict[str, str] = {
    "setting": settings.default_setting_model,
    "creation": settings.default_writer_model,
    "review": settings.default_review_model,
    "extract": settings.default_extract_model,
    "chat": settings.default_chat_model,
}


@dataclass
class RouteConfig:
    task_type: str
    model: str
    provider: str = "openai"
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    context_window: int = 32_000
    api_base: Optional[str] = None

    @property
    def full_model(self) -> str:
        # LiteLLM 格式：provider/model，如 deepseek/deepseek-chat
        if "/" in self.model and "litellm" in self.provider.lower():
            return self.model
        return f"{self.provider}/{self.model}" if "/" not in self.model else self.model


def get_user_default_model(db: Session) -> Optional[dict]:
    """页面「模型接入」选择的默认模型（{provider, model}）。

    自愈：若当前默认模型的服务商已无可用 Key（用户已删除该模型/Key，且无环境变量兜底），
    自动改选其他已配置服务商的模型并回写，保证「当前使用」不会指向已删除的模型。
    """
    row = db.execute(
        select(AppPreference).where(AppPreference.key == "default_model")
    ).scalar_one_or_none()
    if row is None or not row.value:
        return None
    value = row.value
    if not (value.get("provider") and value.get("model")):
        return None
    # 延迟导入，避免与 app.api.models / app.llm.gateway 的循环依赖
    from app.api.models import _pick_fallback_default
    from app.llm.gateway import has_usable_key

    if has_usable_key(value["provider"], value["model"], db):
        return value
    fallback = _pick_fallback_default(db, (value["provider"], value["model"]))
    row.value = fallback
    db.commit()
    return fallback


def resolve_route(db: Session, task_type: str, override: Optional[RouteConfig] = None) -> RouteConfig:
    """解析某任务类型的路由：优先 override → 库中 is_default/最新配置 → 页面默认模型 → 默认配置。"""
    if override is not None:
        return override

    row = db.execute(
        select(ModelRoute)
        .where(ModelRoute.task_type == task_type)
        .order_by(ModelRoute.is_default.desc(), ModelRoute.updated_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    if row is not None:
        return RouteConfig(
            task_type=task_type,
            model=row.model,
            provider=row.provider,
            temperature=row.temperature or 0.7,
            max_tokens=row.max_tokens,
            context_window=row.context_window or 32_000,
        )

    # 未配路由：优先页面「模型接入」选的默认模型，回落系统默认
    user_default = get_user_default_model(db)
    if user_default is not None:
        return RouteConfig(
            task_type=task_type,
            model=user_default["model"],
            provider=user_default["provider"],
            temperature=0.7,
        )

    model = _DEFAULT_TASK_MODELS.get(task_type, "deepseek/deepseek-chat")
    provider, _, name = model.partition("/")
    return RouteConfig(task_type=task_type, model=name, provider=provider, temperature=0.7)


def list_routes(db: Session) -> list[dict]:
    """前端下拉读此表（模型可用性 = 声明式配置）。"""
    rows = db.execute(select(ModelRoute).order_by(ModelRoute.task_type)).scalars().all()
    return [r.__dict__ for r in rows]
