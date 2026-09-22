"""LiteLLM 网关封装：流式 completion + 无 Key 时 Mock 兜底（M0 可无 Key 验证 SSE 链路）。

API Key 优先级：页面配置（provider_keys 表）→ 环境变量。页面保存后实时生效，无需重启。
"""
import asyncio
import logging
import os
import time
from typing import AsyncIterator, Awaitable, Callable, Optional

# 国内网络访问 raw.githubusercontent.com 经常超时：禁用 LiteLLM 联网刷新模型成本表，
# 使用本地备份表，避免首次 LLM 调用被网络阻塞（表现为 SSE 卡住/超时无输出）。
# 必须在 import litellm 之前设置（gateway 内为惰性导入，此设置必然先生效）。
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AppPreference, ProviderKey
from app.llm.routes import RouteConfig

logger = logging.getLogger(__name__)

settings = get_settings()

# 推理模型（deepseek 系）思考与正文共享输出 token 预算：max_tokens 缺省时部分服务端
# 会用很小的默认上限，思考过程一旦吃光预算就只思考不输出正文（正文为空）。
# 显式给一个宽松默认值，保证正文有足够预算产出；模型自行 stop，不会强制写满。
DEFAULT_GENERATION_MAX_TOKENS = 8192

# 单次 LLM 请求总超时（秒）：流式生成可能较长（长思考期 + 长正文），
# 但必须有个上限——否则网络/服务端挂起时请求永不返回，后台任务永久 running，
# 表现为"提取/生成没落库、按钮一直高亮"（曾因无超时卡死 20+ 分钟）。
# 10 分钟覆盖正常生成（实测 novelist/reviser/critic 均在 1-6 分钟内完成）。
LLM_REQUEST_TIMEOUT_SECONDS = 600

# 各 provider 对应的 API Key 环境变量
_PROVIDER_KEY_ENV: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "qwen": "DASHSCOPE_API_KEY",
    "groq": "GROQ_API_KEY",
    "moonshot": "MOONSHOT_API_KEY",
    "zhipu": "ZHIPU_API_KEY",
    "ollama": "OLLAMA_API_KEY",  # Ollama 本地无 Key，M4 支持
    "lmstudio": "LMSTUDIO_API_KEY",
    "azure": "AZURE_API_KEY",
    "volcengine": "VOLCENGINE_API_KEY",  # 火山方舟（按量计费）
    "volcengine-coding": "VOLCENGINE_API_KEY",  # 火山方舟 Coding Plan 订阅套餐
    "volcengine-agent": "VOLCENGINE_API_KEY",  # 火山方舟 Agent Plan 订阅套餐
    "gemini": "GEMINI_API_KEY",
    "xai": "XAI_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "tencent": "TENCENT_API_KEY",
    "siliconflow": "SILICONFLOW_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

# litellm 原生认识的 provider 名（full_model 用 provider/model 前缀）
_LITELLM_NATIVE = {
    "openai", "deepseek", "anthropic", "gemini", "xai", "minimax",
    "qwen", "moonshot", "zhipu", "groq", "openrouter", "ollama",
    "lmstudio", "azure", "volcengine",
}
# 火山方舟订阅套餐：litellm 原生 provider 名统一映射为 volcengine（openai 兼容）
_PLAN_TO_VOLC = {"volcengine-coding", "volcengine-agent"}


def litellm_model_name(provider: str, model: str) -> str:
    """把笔灵的 provider/model 翻译成 litellm 认识的完整模型名。

    - 火山 Plan 套餐 → volcengine/{model}
    - 自定义模型（custom-oa-*）→ openai/{model}（OpenAI 兼容）
    - 自定义模型（custom-an-*）→ anthropic/{model}（Anthropic Messages 格式）
    - 未知 provider → openai/{model}（通用 OpenAI 兼容，配合自定义 base_url）
    """
    if "/" in model:
        return model
    if provider in _PLAN_TO_VOLC:
        return f"volcengine/{model}"
    if provider.startswith("custom-an"):
        return f"anthropic/{model}"
    if provider.startswith("custom-oa"):
        return f"openai/{model}"
    if provider in _LITELLM_NATIVE:
        return f"{provider}/{model}"
    return f"openai/{model}"


def get_provider_credentials(provider: str, db: Optional[Session] = None) -> tuple[Optional[str], Optional[str]]:
    """返回 (api_key, base_url)：优先页面保存的配置，其次环境变量。"""
    if db is not None:
        row = db.execute(select(ProviderKey).where(ProviderKey.provider == provider)).scalar_one_or_none()
        if row is not None and row.api_key:
            return row.api_key, row.base_url or None
    env_name = _PROVIDER_KEY_ENV.get(provider)
    if env_name:
        return os.environ.get(env_name), None
    return None, None


def get_model_credentials(provider: str, model: str, db: Optional[Session] = None) -> tuple[Optional[str], Optional[str]]:
    """返回 (api_key, base_url)：模型专属 Key → 服务商 Key → 环境变量。

    每个模型可独立配置 Key（同一个服务商的不同模型互不影响）；
    未单独配 Key 的模型回落服务商级配置或环境变量。
    """
    if db is not None:
        # 1) 模型专属 Key（「已接入模型」里该模型的独立配置，各负责各）
        pref = db.get(AppPreference, "enabled_models")
        if pref is not None and pref.value:
            for it in pref.value:
                if (
                    isinstance(it, dict)
                    and it.get("provider") == provider
                    and it.get("model") == model
                    and it.get("api_key")
                ):
                    return it["api_key"], it.get("base_url") or None
        # 2) 服务商级配置
        row = db.execute(select(ProviderKey).where(ProviderKey.provider == provider)).scalar_one_or_none()
        if row is not None and row.api_key:
            return row.api_key, row.base_url or None
    # 3) 环境变量
    env_name = _PROVIDER_KEY_ENV.get(provider)
    if env_name:
        return os.environ.get(env_name), None
    return None, None


def has_usable_key(provider: str, model: str, db: Optional[Session] = None) -> bool:
    """(provider, model) 是否可用：模型专属 Key / 服务商 Key / 环境变量 / 本地免 Key 类型。"""
    if provider in ("ollama", "lmstudio", "local"):
        return True
    api_key, _ = get_model_credentials(provider, model, db)
    return bool(api_key)


def has_key_for(provider: str, db: Optional[Session] = None) -> bool:
    """provider 是否已配置 API Key（页面配置 / 环境变量 / 本地免 Key 类型）。"""
    if provider in ("ollama", "lmstudio", "local"):
        return True
    api_key, _ = get_provider_credentials(provider, db)
    if api_key:
        return True
    # 兜底：LiteLLM 兼容其它命名（如自定义 env）
    return False


async def _mock_stream(
    messages: list[dict], route: RouteConfig, delta: float = 0.02, mock_output: str | None = None
) -> AsyncIterator[str]:
    """Mock 流：无 Key 时用于验证 SSE 链路与前端打字机效果。"""
    if mock_output:
        # 有合法样例：按 agent schema 输出，校验/入库链路也能完整演示
        for chunk in _chunk(mock_output, size=40):
            yield chunk
            await asyncio.sleep(delta)
        return
    header = (
        f"[Mock·未配置 {route.provider} API Key，链路验证模式] 任务={route.task_type} "
        f"模型={route.full_model}\n\n"
    )
    body = (
        "这是笔灵 M0 骨架的占位输出。配置对应 provider 的 API Key 后，"
        "LiteLLM 网关会自动切换为真实模型流式生成。\n\n"
        "设定库与记忆层持久化已就绪：settings / chapters / story_state / plot_ledger / "
        "style_profiles / quality_reviews 等全部核心表已建好（见技术设计 §4.1）。\n\n"
        "Agent 统一接口（build_context / run / parse_output）与 SSE 事件流 "
        "（context_ready → stream_delta → stream_end → schema_validate → stored）已打通。"
    )
    for chunk in _chunk(header + body, size=40):
        yield chunk
        await asyncio.sleep(delta)


def _chunk(text: str, size: int) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


async def stream_completion(
    messages: list[dict],
    route: RouteConfig,
    *,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    mock_output: str | None = None,
    db: Optional[Session] = None,
    on_reason: Optional[Callable[[str], Awaitable[None]]] = None,
) -> AsyncIterator[str]:
    """统一流式入口。messages 为 OpenAI 格式 [{"role","content"}]。

    db 提供时优先读取页面保存的 API Key；无 db 时回落环境变量。
    on_reason：推理模型（如 deepseek 系）流式输出中的 reasoning_content 逐段回调，
    供调用方作为"思考中"提示透传给前端。
    """
    temp = temperature if temperature is not None else route.temperature
    tokens = max_tokens or route.max_tokens or DEFAULT_GENERATION_MAX_TOKENS

    logger.info("[gateway] stream_completion enter provider=%s model=%s", route.provider, route.model)
    if not has_usable_key(route.provider, route.model, db):
        if settings.allow_mock_without_key:
            async for piece in _mock_stream(messages, route, mock_output=mock_output):
                yield piece
            return
        raise RuntimeError(
            f"AI 模型未接入：当前请求使用 {route.provider}/{route.model}，但该模型尚未配置 API Key。"
            f"请到「模型」页添加模型并填入 API Key（也可在弹窗内测试连接），配置后再使用 AI 功能。"
        )

    from litellm import acompletion

    api_key, api_base = get_model_credentials(route.provider, route.model, db)
    # provider/model → litellm 完整模型名（火山 Plan、自定义模型、未知 provider 在此归一化）
    litellm_model = litellm_model_name(route.provider, route.model)
    t0 = time.time()
    logger.info("[gateway] acompletion start model=%s api_base=%s", litellm_model, api_base)
    response = await acompletion(
        model=litellm_model,
        messages=messages,
        temperature=temp,
        max_tokens=tokens,
        stream=True,
        api_base=api_base or route.api_base,
        api_key=api_key,
        timeout=LLM_REQUEST_TIMEOUT_SECONDS,  # 防止请求挂起时后台任务永久 running
    )
    logger.info("[gateway] acompletion returned in %.1fs", time.time() - t0)
    yielded_any = False
    finish_reason: Optional[str] = None
    async for chunk in response:
        choices = chunk.choices or []
        if not choices:
            continue
        delta = choices[0].delta
        # 推理过程文字（deepseek 系模型）：单独回调，供前端滚动展示"思考中"，避免用户干等
        reason = getattr(delta, "reasoning_content", None)
        if reason and on_reason is not None:
            await on_reason(reason)
        content = getattr(delta, "content", None)
        if content:
            yielded_any = True
            yield content
        fr = choices[0].finish_reason
        if fr:
            finish_reason = fr
    if not yielded_any:
        # 空输出诊断：推理模型偶发只思考不输出正文（服务端截断/预算耗尽），
        # 记录 finish_reason（length=思考吃光输出预算；stop=模型主动停）供排查。
        logger.warning(
            "[gateway] 本次流式未产出任何正文 content，finish_reason=%s",
            finish_reason,
        )
