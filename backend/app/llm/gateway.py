"""LiteLLM 网关封装：流式 completion。未配置 API Key 时直接报错，无 Mock 演示。

API Key 优先级：页面配置（provider_keys 表）→ 环境变量。页面保存后实时生效，无需重启。
"""
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

from app.db.models import AppPreference, ProviderKey
from app.llm.routes import RouteConfig

logger = logging.getLogger(__name__)

# 推理模型（deepseek 系）思考与正文共享输出 token 预算：max_tokens 缺省时部分服务端
# 会用很小的默认上限，思考过程一旦吃光预算就只思考不输出正文（正文为空）。
# 显式给一个宽松默认值，保证正文有足够预算产出；模型自行 stop，不会强制写满。
DEFAULT_GENERATION_MAX_TOKENS = 8192

# 单次 LLM 请求总超时（秒）：流式生成可能较长（长思考期 + 长正文），
# 但必须有个上限——否则网络/服务端挂起时请求永不返回，后台任务永久 running，
# 表现为"提取/生成没落库、按钮一直高亮"（曾因无超时卡死 20+ 分钟）。
# 15 分钟覆盖慢模型（推理模型思考期长 + 服务端波动）下的正常生成。
LLM_REQUEST_TIMEOUT_SECONDS = 900

# 各 provider 对应的 API Key 环境变量
_PROVIDER_KEY_ENV: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "qwen": "DASHSCOPE_API_KEY",
    "groq": "GROQ_API_KEY",
    "moonshot": "MOONSHOT_API_KEY",
    "zhipu": "ZHIPU_API_KEY",
    "ollama": "OLLAMA_API_KEY",  # Ollama 本地无 Key
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


class LLMError(RuntimeError):
    """LLM 调用失败：统一分类 + 用户可读中文提示。

    category ∈ {no_key, quota, rate_limit, timeout, auth, connection,
                bad_request, server, other}
    friendly：面向作者的中文提示（含下一步指引）；__str__ 返回 friendly，
    使 pipeline / stream 的 str(e) 自动透传友好文案（任务 error、stream_error 事件同源）。
    """

    def __init__(self, category: str, friendly: str, original: str = ""):
        super().__init__(friendly)
        self.category = category
        self.friendly = friendly
        self.original = original

    def __str__(self) -> str:  # type: ignore[override]
        return self.friendly


# 额度/套餐耗尽信号词（用于 429/400 错误里区分"额度问题"与"普通限流/参数问题"）
_QUOTA_WORDS = (
    "quota", "insufficient", "exhausted", "balance", "arrear",
    "accountarrearage", "资源包", "额度", "套餐", "欠费", "已用尽", "充值",
)
# 超长输入信号词（BadRequest 里区分"超上下文"与其它参数错误）
_LENGTH_WORDS = ("context", "length", "token limit", "prompt too long", "超长", "长度", "超出")


def _quota_hint(is_plan: bool) -> str:
    if is_plan:
        return (
            "模型的订阅套餐额度/次数已用尽或已到期，请求被拒绝。"
            "请到服务商控制台续费/升级套餐后重试，或切换到其他已接入的模型继续生成。"
        )
    return (
        "模型账户的 API 额度/余额已用尽或欠费，请求被拒绝。"
        "请到服务商控制台充值或开通额度后重试，或切换到其他已接入的模型继续生成。"
    )


def _friendly_llm_error(e: Exception, provider: str) -> LLMError:
    """把 litellm / 底层网络异常翻译成带分类的中文提示（后端统一在此处"说人话"）。

    顺序敏感：InsufficientQuotaError 继承自 RateLimitError，必须最先判断；
    400/429 里先按关键词区分「额度耗尽」再落普通限流/参数错误。
    """
    name = type(e).__name__
    status = getattr(e, "status_code", None) or getattr(e, "status", None)
    msg = str(e)
    low = msg.lower()
    is_plan = provider in ("volcengine-coding", "volcengine-agent")

    def hit(words: tuple[str, ...]) -> bool:
        return any(w in low for w in words)

    def is_rate() -> bool:
        # 普通限流信号：优先归 rate_limit，避免与配额超限（同样含 limit/exceeded）混淆
        return "rate limit" in low or "too many" in low or "requests per" in low

    def hit_quota() -> bool:
        if is_rate():
            return False
        return hit(_QUOTA_WORDS) or "exceeded" in low or "capacity" in low

    try:  # litellm 异常类（惰性导入，避免顶层 import 触发模型成本表联网）
        from litellm.exceptions import (  # noqa: F401
            APIConnectionError, AuthenticationError, BadRequestError,
            ContextWindowExceededError, InternalServerError, PermissionDeniedError,
            RateLimitError, ServiceUnavailableError, Timeout,
        )
        classes_ok = True
    except Exception:
        classes_ok = False

    # 429 类：限流与配额耗尽共用状态码，按信号词区分（InsufficientQuota 在 litellm 里
    # 无独立类，统一落 RateLimitError / 429 关键词判断）
    if (classes_ok and isinstance(e, RateLimitError)) or status == 429:
        if hit_quota():
            return LLMError("quota", _quota_hint(is_plan), msg)
        return LLMError(
            "rate_limit",
            "请求触发限流（429），请稍等片刻后重试；若持续限流，可降低并发或联系服务商提升限额。",
            msg,
        )
    if (classes_ok and isinstance(e, AuthenticationError)) or status == 401:
        return LLMError(
            "auth",
            "模型 API Key 无效或无权限（401），请到「模型」页检查并更新该模型的 API Key 后重试。",
            msg,
        )
    # 403：额度不足（Insufficient Quota）或权限拒绝
    if (classes_ok and isinstance(e, PermissionDeniedError)) or status == 403:
        if hit_quota():
            return LLMError("quota", _quota_hint(is_plan), msg)
        return LLMError(
            "auth",
            "模型访问被拒绝（403），请检查该模型的 API Key 是否有权限调用当前模型。",
            msg,
        )
    # 超时（litellm.Timeout 继承 openai.APITimeoutError）
    if (classes_ok and isinstance(e, Timeout)) or "timeout" in low:
        return LLMError(
            "timeout",
            "模型响应超时（网络或服务端繁忙），请稍后重试；若反复超时，可切换到更快的模型。",
            msg,
        )
    if (classes_ok and isinstance(e, APIConnectionError)) or "connection" in name.lower() or hit(
        ("connecterror", "connectionerror", "network", "unreachable", "getaddrinfo", "econnrefused", "name or service")
    ):
        return LLMError(
            "connection",
            "无法连接到模型服务（网络异常或服务不可达），请检查网络后重试。",
            msg,
        )
    # 400 类：超上下文 → 额度 → 其它参数错误
    if status == 400 or (classes_ok and isinstance(e, BadRequestError)):
        if (classes_ok and isinstance(e, ContextWindowExceededError)) or hit(_LENGTH_WORDS):
            return LLMError(
                "bad_request",
                "输入内容超出模型上下文上限，请精简内容（或分段处理）后重试。",
                msg,
            )
        if hit_quota():
            return LLMError("quota", _quota_hint(is_plan), msg)
        return LLMError("bad_request", f"请求被模型服务拒绝（400）：{msg[:200]}", msg)
    if status is not None and isinstance(status, int) and 500 <= status < 600:
        return LLMError("server", "模型服务端暂时不可用（5xx），请稍后重试。", msg)
    if classes_ok and isinstance(e, ServiceUnavailableError):
        return LLMError("server", "模型服务端暂时不可用（503），请稍后重试。", msg)
    return LLMError("other", f"模型调用失败：{msg[:300]}", msg)


async def stream_completion(
    messages: list[dict],
    route: RouteConfig,
    *,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
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
    try:
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
    except Exception as e:  # 连接/鉴权/限流/额度/超时等，统一分类成中文提示
        raise _friendly_llm_error(e, route.provider) from e
    logger.info("[gateway] acompletion returned in %.1fs", time.time() - t0)
    yielded_any = False
    finish_reason: Optional[str] = None
    try:
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
    except Exception as e:  # 流式中途断连/服务端错误，同样分类
        raise _friendly_llm_error(e, route.provider) from e
    if not yielded_any:
        # 空输出诊断：推理模型偶发只思考不输出正文（服务端截断/预算耗尽），
        # 记录 finish_reason（length=思考吃光输出预算；stop=模型主动停）供排查。
        logger.warning(
            "[gateway] 本次流式未产出任何正文 content，finish_reason=%s",
            finish_reason,
        )
