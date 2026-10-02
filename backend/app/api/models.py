"""模型路由/探测接口：模型可用性 = 声明式配置 + 探测辅助。"""
import datetime
import os
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AppPreference, ModelRoute, ProviderKey
from app.db.session import get_db
from app.llm.gateway import _PROVIDER_KEY_ENV
from app.llm.routes import get_user_default_model, list_routes

router = APIRouter(prefix="/api/models", tags=["models"])

# 全部任务类型：设定 / 创作 / 提取 / 编年 / 评价（高级设置路由按 task_type 唯一）
# 排序按创作流水线：设定（地基）→ 创作（正文）→ 提取（每章记忆）→ 编年（跨章压缩）→ 评价（审稿收尾）
TASK_TYPES = ["setting", "creation", "extract", "chronicle", "review"]

# 页面「添加模型」弹窗的预置服务商目录（参考 TRAE：自定义模型置顶 + 预设服务商 + 选模型填 Key）
# provider 命名尽量用 litellm 原生 provider 名；未知的由 gateway 统一走 OpenAI 兼容
MODEL_CATALOG: list[dict] = [
    {
        "provider": "deepseek",
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "key_env": "DEEPSEEK_API_KEY",
        "key_url": "https://platform.deepseek.com/api_keys",
        "models": [
            {"id": "deepseek-v4-flash", "label": "DeepSeek-V4-Flash · 便宜够用，非思考+思考双模式"},
            {"id": "deepseek-flash", "label": "DeepSeek-V4.1-Flash · 最新架构，原生多模态"},
            {"id": "deepseek-v4-pro", "label": "DeepSeek-V4-Pro · 强推理，更贵"},
        ],
    },
    {
        "provider": "moonshot",
        "label": "Kimi（月之暗面）",
        "base_url": "https://api.moonshot.cn/v1",
        "key_env": "MOONSHOT_API_KEY",
        "key_url": "https://platform.moonshot.cn/console/api-keys",
        "models": [
            {"id": "kimi-k3", "label": "Kimi-K3 · 旗舰，100万上下文"},
            {"id": "kimi-k2.7-code", "label": "Kimi-K2.7-Code · 编程强"},
            {"id": "kimi-k2.7-code-highspeed", "label": "Kimi-K2.7-Code-HighSpeed · 高速版"},
            {"id": "kimi-k2.6", "label": "Kimi-K2.6 · 视觉+文本"},
        ],
    },
    {
        "provider": "qwen",
        "label": "通义千问（阿里云百炼）",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "key_env": "DASHSCOPE_API_KEY",
        "key_url": "https://bailian.console.aliyun.com/#/api-key",
        "models": [
            {"id": "qwen3.8-max", "label": "Qwen3.8-Max · 旗舰"},
            {"id": "qwen3.8-flash", "label": "Qwen3.8-Flash · 便宜快"},
            {"id": "qwen3.7-max", "label": "Qwen3.7-Max · 上一代旗舰"},
            {"id": "qwen-plus", "label": "qwen-plus · 稳定平衡"},
            {"id": "qwen-turbo", "label": "qwen-turbo · 便宜快"},
        ],
    },
    {
        "provider": "zhipu",
        "label": "智谱 GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "key_env": "ZHIPU_API_KEY",
        "key_url": "https://open.bigmodel.cn/usercenter/apikeys",
        "models": [
            {"id": "glm-5.3", "label": "GLM-5.3 · 最新旗舰"},
            {"id": "glm-5.2", "label": "GLM-5.2 · Coding/长程任务强"},
            {"id": "glm-5.3-flash", "label": "GLM-5.3-Flash · 高速低价"},
            {"id": "glm-4.7", "label": "GLM-4.7 · 开源Coding"},
            {"id": "glm-4-flash", "label": "GLM-4-Flash · 免费"},
        ],
    },
    {
        "provider": "openai",
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "key_env": "OPENAI_API_KEY",
        "key_url": "https://platform.openai.com/api-keys",
        "models": [
            {"id": "gpt-5.4", "label": "GPT-5.4 · 推理旗舰"},
            {"id": "gpt-5.3", "label": "GPT-5.3"},
            {"id": "gpt-5", "label": "GPT-5"},
            {"id": "gpt-4o-mini", "label": "GPT-4o mini · 便宜"},
        ],
    },
    {
        "provider": "anthropic",
        "label": "Anthropic · Claude",
        "base_url": "https://api.anthropic.com",
        "key_env": "ANTHROPIC_API_KEY",
        "key_url": "https://console.anthropic.com/settings/keys",
        "models": [
            {"id": "claude-opus-5-5", "label": "Claude Opus 5.5 · 主力推荐"},
            {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5 · 速度智能均衡"},
            {"id": "claude-fable-5-1", "label": "Claude Fable 5.1 · 顶级推理（贵）"},
            {"id": "claude-haiku-4-5", "label": "Claude Haiku 4.5 · 最快最便宜"},
        ],
    },
    {
        "provider": "gemini",
        "label": "Google Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_env": "GEMINI_API_KEY",
        "key_url": "https://aistudio.google.com/apikey",
        "models": [
            {"id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash · 最新"},
            {"id": "gemini-3.7-flash", "label": "Gemini 3.7 Flash"},
            {"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash"},
            {"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite · 便宜"},
        ],
    },
    {
        "provider": "xai",
        "label": "xAI · Grok",
        "base_url": "https://api.x.ai/v1",
        "key_env": "XAI_API_KEY",
        "key_url": "https://console.x.ai/",
        "models": [
            {"id": "grok-4.7", "label": "Grok 4.7 · 最新旗舰"},
            {"id": "grok-4.6", "label": "Grok 4.6 · 长程Agent强"},
            {"id": "grok-4.3", "label": "Grok 4.3"},
            {"id": "grok-3-mini", "label": "Grok 3 Mini · 便宜快"},
        ],
    },
    {
        "provider": "minimax",
        "label": "MiniMax",
        "base_url": "https://api.minimaxi.com/v1",
        "key_env": "MINIMAX_API_KEY",
        "key_url": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        "models": [
            {"id": "MiniMax-M3", "label": "MiniMax-M3 · 最新"},
            {"id": "MiniMax-M2.7", "label": "MiniMax-M2.7"},
            {"id": "MiniMax-M2.1", "label": "MiniMax-M2.1"},
        ],
    },
    {
        "provider": "volcengine",
        "label": "火山引擎 · 方舟",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "key_env": "VOLCENGINE_API_KEY",
        "key_url": "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
        # 三种配置方式（对应原先三个服务商）：按量计费 / Coding Plan 订阅 / Agent Plan 订阅
        "config_modes": [
            {
                "key": "payg",
                "label": "按量计费（api/v3）",
                "base_url": "https://ark.cn-beijing.volces.com/api/v3",
                "hint": "按量计费端点，不会消耗订阅套餐额度",
                "models": [
                    {"id": "doubao-seed-2-1-pro-260915", "label": "Doubao-Seed-2.1-Pro · 最新推荐"},
                    {"id": "doubao-seed-2-1-lite-260915", "label": "Doubao-Seed-2.1-Lite · 三模态/1M"},
                    {"id": "doubao-seed-2-1-turbo-260628", "label": "Doubao-Seed-2.1-Turbo · 高性价比"},
                    {"id": "doubao-seed-evolving", "label": "Doubao-Seed-Evolving · 周级迭代"},
                    {"id": "doubao-seed-2-0-lite-260428", "label": "Doubao-Seed-2.0-Lite"},
                    {"id": "doubao-seed-2-0-mini-260428", "label": "Doubao-Seed-2.0-Mini"},
                ],
            },
            {
                "key": "coding",
                "label": "Coding Plan 订阅（ark-code-latest）",
                "base_url": "https://ark.cn-beijing.volces.com/api/coding/v3",
                "hint": "模型固定为 ark-code-latest，由控制台 Auto 切换具体模型",
                "models": [
                    {"id": "ark-code-latest", "label": "自动选择（推荐，控制台 Auto 切换）"},
                    {"id": "doubao-seed-2.0-code", "label": "Doubao-Seed-2.0-Code"},
                    {"id": "doubao-seed-2.0-pro", "label": "Doubao-Seed-2.0-Pro · 更强"},
                    {"id": "doubao-seed-2.0-lite", "label": "Doubao-Seed-2.0-Lite · 轻量快"},
                    {"id": "deepseek-v4-flash", "label": "DeepSeek-V4-Flash · 快"},
                    {"id": "deepseek-v4-pro", "label": "DeepSeek-V4-Pro · 强推理"},
                    {"id": "kimi-k2.6", "label": "Kimi-K2.6"},
                    {"id": "kimi-k2.7-code", "label": "Kimi-K2.7-Code"},
                    {"id": "glm-5.2", "label": "GLM-5.2"},
                    {"id": "glm-5.3", "label": "GLM-5.3"},
                    {"id": "minimax-m2.7", "label": "MiniMax-M2.7"},
                    {"id": "minimax-m3", "label": "MiniMax-M3"},
                ],
            },
            {
                "key": "agent",
                "label": "Agent Plan 订阅（model-name）",
                "base_url": "https://ark.cn-beijing.volces.com/api/plan/v3",
                "hint": "从下方选择或输入模型 ID（官方 model-name 配置，TRAE 同款）",
                "models": [
                    {"id": "doubao-seed-2.1-turbo", "label": "Doubao-Seed-2.1-Turbo"},
                    {"id": "doubao-seed-2.1-lite", "label": "Doubao-Seed-2.1-Lite"},
                    {"id": "doubao-seed-2.0-lite", "label": "Doubao-Seed-2.0-Lite"},
                    {"id": "doubao-seed-2.0-mini", "label": "Doubao-Seed-2.0-Mini"},
                    {"id": "kimi-k2.7-code", "label": "Kimi-K2.7-Code"},
                    {"id": "minimax-m3", "label": "MiniMax-M3"},
                    {"id": "doubao-seed-evolving", "label": "Doubao-Seed-Evolving"},
                    {"id": "kimi-k3", "label": "Kimi-K3"},
                    {"id": "doubao-seed-2.1-pro", "label": "Doubao-Seed-2.1-Pro"},
                    {"id": "deepseek-v4-flash", "label": "DeepSeek-V4-Flash · 快"},
                    {"id": "glm-5.3", "label": "GLM-5.3"},
                    {"id": "glm-5.3-flash", "label": "GLM-5.3-Flash"},
                    {"id": "deepseek-v4-pro", "label": "DeepSeek-V4-Pro · 强推理"},
                ],
            },
        ],
        # 兼容字段（默认展示 Agent Plan 的模型清单；弹窗内以 config_modes 为准）
        "models": [
            {"id": "doubao-seed-2.1-turbo", "label": "Doubao-Seed-2.1-Turbo"},
            {"id": "doubao-seed-2.1-lite", "label": "Doubao-Seed-2.1-Lite"},
            {"id": "doubao-seed-2.0-lite", "label": "Doubao-Seed-2.0-Lite"},
            {"id": "doubao-seed-2.0-mini", "label": "Doubao-Seed-2.0-Mini"},
            {"id": "kimi-k2.7-code", "label": "Kimi-K2.7-Code"},
            {"id": "minimax-m3", "label": "MiniMax-M3"},
            {"id": "doubao-seed-evolving", "label": "Doubao-Seed-Evolving"},
            {"id": "kimi-k3", "label": "Kimi-K3"},
            {"id": "doubao-seed-2.1-pro", "label": "Doubao-Seed-2.1-Pro"},
            {"id": "deepseek-v4-flash", "label": "DeepSeek-V4-Flash · 快"},
            {"id": "glm-5.3", "label": "GLM-5.3"},
            {"id": "glm-5.3-flash", "label": "GLM-5.3-Flash"},
            {"id": "deepseek-v4-pro", "label": "DeepSeek-V4-Pro · 强推理"},
        ],
    },
    {
        "provider": "tencent",
        "label": "腾讯云 · 大模型知识引擎",
        "base_url": "https://api.lkeap.cloud.tencent.com/v1",
        "key_env": "TENCENT_API_KEY",
        "key_url": "https://console.cloud.tencent.com/lkeap",
        "models": [
            {"id": "deepseek-v4", "label": "DeepSeek-V4"},
            {"id": "hunyuan-turbos-latest", "label": "混元 Turbo"},
            {"id": "hunyuan-t1-latest", "label": "混元 T1 · 推理"},
        ],
    },
    {
        "provider": "siliconflow",
        "label": "硅基流动 SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "key_env": "SILICONFLOW_API_KEY",
        "key_url": "https://cloud.siliconflow.cn/account/ak",
        "models": [
            {"id": "deepseek-ai/DeepSeek-V4", "label": "DeepSeek-V4"},
            {"id": "deepseek-ai/DeepSeek-V3", "label": "DeepSeek-V3"},
            {"id": "Qwen/Qwen3.5-397B-A17B", "label": "Qwen3.5-397B"},
            {"id": "Qwen/Qwen3-235B-A22B", "label": "Qwen3-235B"},
        ],
    },
    {
        "provider": "openrouter",
        "label": "OpenRouter（聚合）",
        "base_url": "https://openrouter.ai/api/v1",
        "key_env": "OPENROUTER_API_KEY",
        "key_url": "https://openrouter.ai/settings/keys",
        "models": [
            {"id": "deepseek/deepseek-v4-flash", "label": "DeepSeek-V4-Flash"},
            {"id": "deepseek/deepseek-v4-pro", "label": "DeepSeek-V4-Pro"},
            {"id": "anthropic/claude-opus-5-5", "label": "Claude Opus 5.5"},
            {"id": "anthropic/claude-sonnet-5-5", "label": "Claude Sonnet 5.5"},
        ],
    },
    {
        "provider": "ollama",
        "label": "Ollama（本地免费）",
        "base_url": "http://localhost:11434/v1",
        "key_env": "OLLAMA_API_KEY",
        "key_url": "https://ollama.com/library",
        "models": [
            {"id": "qwen3:8b", "label": "qwen3:8b"},
            {"id": "llama3.3:8b", "label": "llama3.3:8b"},
            {"id": "deepseek-r1:8b", "label": "deepseek-r1:8b"},
        ],
    },
]


class ProbeRequest(BaseModel):
    """模型探测入参：provider + api_key（仅本次探测使用，不落库）+ 可选 base_url / model。"""
    provider: str = Field(..., description="如 openai / deepseek / qwen / anthropic")
    api_key: str = Field(..., description="该 provider 的 API Key（仅本次探测使用，不落库）")
    base_url: str | None = None
    model: str | None = Field(default=None, description="要验证的模型名；订阅套餐端点不支持 GET /models 时用它发最小 chat 请求验证")


class ProbeResponse(BaseModel):
    """模型探测结果：该 Key 可用的模型 id 列表。"""
    models: list[str]


class RouteUpsert(BaseModel):
    """新增/更新路由：task_type 唯一（upsert 语义）。"""
    task_type: str = Field(..., pattern="^(setting|creation|review|extract|chronicle)$")
    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    temperature: Optional[float] = Field(default=None, ge=0, le=2)
    max_tokens: Optional[int] = Field(default=None, ge=1)
    context_window: Optional[int] = Field(default=None, ge=1000)
    is_default: bool = False


class RouteRead(BaseModel):
    """路由读模型（ORM 直读返回，对应 model_routes 表）。"""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    task_type: str
    provider: str
    model: str
    temperature: Optional[float]
    max_tokens: Optional[int]
    context_window: Optional[int]
    is_default: bool


class ProviderKeySave(BaseModel):
    """页面保存 provider 的 API Key（明文仅存本地库，不回显）。"""
    api_key: str = Field(..., min_length=1)
    base_url: Optional[str] = None


class CustomModelSave(BaseModel):
    """「添加模型」弹窗的自定义配置：接入未预设的模型/中转（对应 TRAE 的自定义配置）。"""
    label: str = Field(..., min_length=1, description="模型展示名称")
    api_format: str = Field("openai", pattern="^(openai|anthropic)$")
    base_url: str = Field(..., min_length=1, description="请求地址（base，不含 /chat/completions 或 /v1/messages）")
    model_id: str = Field(..., min_length=1)
    api_key: str = Field(..., min_length=1)


class DefaultModel(BaseModel):
    """默认模型保存入参：provider + model（页面「模型接入」选择的全任务默认）。"""
    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)


def _list_custom_models(db: Session) -> list[dict]:
    """「自定义配置」添加的模型（存 AppPreference.custom_models）。"""
    pref = db.get(AppPreference, "custom_models")
    if pref is None or not pref.value:
        return []
    return [item for item in pref.value if isinstance(item, dict)]


def _list_enabled_models(db: Session) -> list[dict]:
    """预设服务商已接入的模型清单（存 AppPreference.enabled_models）。

    一个服务商一个 Key，可接入该服务商的多个模型；每项 {provider, model, label}。
    """
    pref = db.get(AppPreference, "enabled_models")
    if pref is None or not pref.value:
        return []
    return [
        item for item in pref.value
        if isinstance(item, dict) and item.get("provider") and item.get("model")
    ]


# ============ 模型列表「动态刷新」缓存 ============
# 服务商的模型会持续更新，静态目录（MODEL_CATALOG）只能作为首次兜底种子。
# 用户填入有效 Key 后，可一键「刷新模型列表」从服务商拉取账号下的真实模型，
# 结果缓存到 AppPreference.catalog_live_models，catalog 接口优先用缓存覆盖静态目录。
# 缓存结构：{provider: {"updated_at": iso, "models": [{id,label}]}}
LIVE_MODELS_KEY = "catalog_live_models"


def _get_live_models(db: Session) -> dict:
    pref = db.get(AppPreference, LIVE_MODELS_KEY)
    if pref is None or not isinstance(pref.value, dict):
        return {}
    return pref.value


def _set_live_models(db: Session, provider: str, models: list[dict]) -> None:
    pref = db.get(AppPreference, LIVE_MODELS_KEY)
    if pref is None:
        pref = AppPreference(key=LIVE_MODELS_KEY)
        db.add(pref)
    data = dict(pref.value or {})
    data[provider] = {
        "updated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "models": [{"id": m["id"], "label": m.get("label") or m["id"]} for m in models if m.get("id")],
    }
    pref.value = data
    db.commit()


def _clear_live_models(db: Session, provider: str) -> None:
    """删除某服务商的刷新缓存（如用户删除该服务商全部模型时一并清理，避免残留）。"""
    pref = db.get(AppPreference, LIVE_MODELS_KEY)
    if pref is None or not isinstance(pref.value, dict):
        return
    data = dict(pref.value)
    if provider in data:
        data.pop(provider)
        pref.value = data
        db.commit()


def _set_enabled_models(db: Session, items: list[dict]) -> None:
    """整体回写已接入模型清单（幂等，按 provider+model 去重）。"""
    unique: dict[tuple[str, str], dict] = {}
    for it in items:
        unique[(it["provider"], it["model"])] = it
    pref = db.get(AppPreference, "enabled_models")
    if pref is None:
        pref = AppPreference(key="enabled_models")
        db.add(pref)
    pref.value = list(unique.values())


def _model_label(provider: str, model: str) -> str:
    """预置目录里的模型展示名；不在目录里的回退为模型 ID。"""
    for p in MODEL_CATALOG:
        if p["provider"] == provider:
            for m in p["models"]:
                if m["id"] == model:
                    return m["label"]
            break
    return model


@router.get("/catalog")
def model_catalog(db: Session = Depends(get_db)):
    """预置模型目录 + 自定义模型：服务商 + 官方地址 + 推荐模型 + Key 配置状态（前端「添加模型」弹窗一次拉取）。

    模型列表 = 刷新缓存（用户用 Key 从服务商拉取的真实模型，带 live 标记）优先，
    无缓存时回落静态目录（MODEL_CATALOG 种子）。刷新缓存的存在意味着用户已用真实 Key 校准过，
    静态目录里的过时模型不会再展示。
    """
    rows = {r.provider: r for r in db.execute(select(ProviderKey)).scalars().all()}
    enabled = _list_enabled_models(db)
    live = _get_live_models(db)
    enabled_by_provider: dict[str, list[dict]] = {}
    for it in enabled:
        enabled_by_provider.setdefault(it["provider"], []).append(it)
    out = []
    for p in MODEL_CATALOG:
        row = rows.get(p["provider"])
        configured, source = False, None
        if row is not None and row.api_key:
            configured, source = True, "db"
        elif p.get("key_env") and os.environ.get(p["key_env"]):
            configured, source = True, "env"
        # 已接入模型（模型级独立 Key 存于 enabled_models）也算已配置，否则添加了模型 AI 仍被判为未就绪
        elif enabled_by_provider.get(p["provider"]):
            configured, source = True, "db"
        # 刷新缓存优先：用户用真实 Key 从服务商拉到的模型列表，覆盖静态种子目录
        live_item = live.get(p["provider"])
        models = live_item["models"] if live_item else p["models"]
        out.append({
            "provider": p["provider"],
            "label": p["label"],
            "base_url": p["base_url"],
            "key_url": p.get("key_url"),
            "note": p.get("note"),
            "models": models,
            "config_modes": p.get("config_modes"),
            "configured": configured,
            "source": source,
            "custom": False,
            "live": bool(live_item),
            "live_updated_at": (live_item or {}).get("updated_at"),
            "enabledModels": [{"model": it["model"], "label": it.get("label") or it["model"]} for it in enabled_by_provider.get(p["provider"], [])],
        })
    # 自定义配置的模型（每个是一个独立"服务商"，内含单个模型）
    for c in _list_custom_models(db):
        row = rows.get(c["provider"])
        configured = row is not None and bool(row.api_key)
        out.append({
            "provider": c["provider"],
            "label": c.get("label") or c.get("model_id", c["provider"]),
            "base_url": c["base_url"],
            "key_url": None,
            "note": c.get("api_format") == "anthropic" and "Anthropic Messages 格式" or "OpenAI 兼容格式",
            "models": [{"id": c["model_id"], "label": c.get("label") or c["model_id"]}],
            "configured": configured,
            "source": "db" if configured else None,
            "custom": True,
            "api_format": c.get("api_format", "openai"),
        })
    return out


@router.get("/default")
def get_default_model(db: Session = Depends(get_db)):
    """当前默认模型（页面「模型接入」选择的，全任务使用）；未配置时返回 null，前端按未就绪提示去配置模型。"""
    return get_user_default_model(db)


@router.put("/default")
def set_default_model(payload: DefaultModel, db: Session = Depends(get_db)):
    """保存默认模型；未配置模型路由时所有任务都走它。"""
    row = db.get(AppPreference, "default_model")
    if row is None:
        row = AppPreference(key="default_model")
        db.add(row)
    row.value = {"provider": payload.provider, "model": payload.model}
    db.commit()
    return {"ok": True, "provider": payload.provider, "model": payload.model}


@router.get("/keys")
def list_provider_keys(db: Session = Depends(get_db)):
    """页面「模型接入」读此接口：各 provider 是否已配置（不回显明文 key）。

    优先级：页面保存（provider_keys 表）> 环境变量。
    """
    rows = db.execute(select(ProviderKey)).scalars().all()
    db_conf = {r.provider: r for r in rows}
    result: dict[str, dict] = {}
    for p in MODEL_CATALOG:
        provider, default_base = p["provider"], p["base_url"]
        row = db_conf.get(provider)
        if row is not None and row.api_key:
            result[provider] = {
                "configured": True,
                "source": "db",
                "base_url": row.base_url or None,
                "default_base_url": default_base,
            }
        elif _PROVIDER_KEY_ENV.get(provider) and os.environ.get(_PROVIDER_KEY_ENV[provider]):
            result[provider] = {
                "configured": True,
                "source": "env",
                "base_url": None,
                "default_base_url": default_base,
            }
        else:
            result[provider] = {
                "configured": False,
                "source": None,
                "base_url": None,
                "default_base_url": default_base,
            }
    return result


@router.put("/keys/{provider}")
def save_provider_key(provider: str, payload: ProviderKeySave, db: Session = Depends(get_db)):
    """页面保存 API Key；保存后 gateway 实时读取，无需重启。"""
    row = db.get(ProviderKey, provider)
    if row is None:
        row = ProviderKey(provider=provider)
        db.add(row)
    row.api_key = payload.api_key.strip()
    row.base_url = (payload.base_url or "").strip() or None
    db.commit()
    return {"ok": True, "provider": provider, "configured": True}


def _pick_fallback_default(db: Session, exclude: tuple[str, str | None]) -> Optional[dict]:
    """删除当前默认模型后，自动改用其他可用模型；没有可用模型时返回 None（清空默认）。

    exclude = (provider, model)：model 为 None 表示整个 provider 已不可用（如删 Key/删自定义模型），
    需排除该 provider 全部；model 非 None 表示只移除该模型（服务商 Key 还在），同服务商其他已接入模型仍可用。

    优先级：其他已接入清单里的模型（同 Key 即用）→ 其他已配置服务商的推荐模型。
    """
    from app.llm.gateway import has_key_for, has_usable_key

    exclude_provider, exclude_model = exclude

    # 1) 其他已接入的模型（用户明确接入过，优先；按模型逐个判断可用性）
    for it in _list_enabled_models(db):
        if it["provider"] == exclude_provider and (exclude_model is None or it["model"] == exclude_model):
            continue
        if has_usable_key(it["provider"], it["model"], db):
            return {"provider": it["provider"], "model": it["model"]}

    # 2) 其他已配置服务商的推荐模型
    rows = {r.provider: r for r in db.execute(select(ProviderKey)).scalars().all()}
    for p in MODEL_CATALOG:
        if p["provider"] == exclude_provider:
            continue
        row = rows.get(p["provider"])
        if (row is not None and row.api_key) or (
            p.get("key_env") and os.environ.get(p["key_env"])
        ):
            if p["models"]:
                return {"provider": p["provider"], "model": p["models"][0]["id"]}
    for c in _list_custom_models(db):
        if c.get("provider") == exclude_provider or not c.get("model_id"):
            continue
        row = rows.get(c["provider"])
        if row is not None and row.api_key:
            return {"provider": c["provider"], "model": c["model_id"]}
    return None


@router.delete("/keys/{provider}", status_code=204)
def delete_provider_key(provider: str, db: Session = Depends(get_db)):
    """删除服务商级兜底 Key（回落环境变量 / Mock）。

    已接入模型各自持有独立 Key，不受影响（各负责各）。
    默认模型若既无模型专属 Key、服务商级 Key 又被删除、且无环境变量兜底，
    自动改用其他可用模型；没有其他可用模型则清空默认。
    """
    from app.llm.gateway import has_usable_key

    row = db.get(ProviderKey, provider)
    if row is not None:
        db.delete(row)

    provider_def = next((p for p in MODEL_CATALOG if p["provider"] == provider), None)
    env_still = bool(
        provider_def
        and provider_def.get("key_env")
        and os.environ.get(provider_def["key_env"])
    )

    dft = db.get(AppPreference, "default_model")
    if dft is not None and dft.value and dft.value.get("provider") == provider and not env_still:
        if not has_usable_key(dft.value["provider"], dft.value["model"], db):
            dft.value = _pick_fallback_default(db, (provider, dft.value["model"]))
    db.commit()


class AccessModelSave(BaseModel):
    """把预设服务商的一个模型加入已接入清单（每个模型独立保存自己的 Key，各负责各）。

    同一个服务商的不同模型互不影响；重复添加同一个 (provider, model) 时更新该条。
    """
    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    label: Optional[str] = None
    base_url: Optional[str] = None
    api_key: str = Field(..., min_length=1)


@router.post("/access")
def add_access_model(payload: AccessModelSave, db: Session = Depends(get_db)):
    """接入预设服务商的一个模型：写入清单（含该模型独立的 base_url / api_key，不回显给前端）。

    模型专属 Key 独立保存，不会覆盖同服务商其他模型的 Key。
    """
    items = _list_enabled_models(db)
    updated = False
    for it in items:
        if it["provider"] == payload.provider and it["model"] == payload.model:
            it["label"] = payload.label or it.get("label") or _model_label(payload.provider, payload.model)
            it["base_url"] = payload.base_url
            it["api_key"] = payload.api_key
            updated = True
            break
    if not updated:
        items.append({
            "provider": payload.provider,
            "model": payload.model,
            "label": payload.label or _model_label(payload.provider, payload.model),
            "base_url": payload.base_url,
            "api_key": payload.api_key,
        })
    _set_enabled_models(db, items)
    db.commit()
    return {"ok": True, "provider": payload.provider, "model": payload.model}


@router.delete("/access", status_code=204)
def remove_access_model(provider: str, model: str, db: Session = Depends(get_db)):
    """从已接入清单移除一个模型；若移除的正是当前默认模型则自动改用其他可用模型。

    高级设置路由里引用了该 (provider, model) 的配置一并删除（避免路由指向已移除的模型）。
    """
    items = [it for it in _list_enabled_models(db) if not (it["provider"] == provider and it["model"] == model)]
    _set_enabled_models(db, items)
    for r in db.execute(
        select(ModelRoute).where(ModelRoute.provider == provider, ModelRoute.model == model)
    ).scalars().all():
        db.delete(r)
    dft = db.get(AppPreference, "default_model")
    if dft is not None and dft.value and dft.value.get("provider") == provider and dft.value.get("model") == model:
        dft.value = _pick_fallback_default(db, (provider, model))
    db.commit()


@router.post("/custom")
def save_custom_model(payload: CustomModelSave, db: Session = Depends(get_db)):
    """「添加模型」弹窗的自定义配置：写入 ProviderKey（key+base_url）+ custom_models 清单。"""
    prefix = "custom-oa" if payload.api_format == "openai" else "custom-an"
    provider = f"{prefix}-{uuid.uuid4().hex[:8]}"
    api_key = payload.api_key.strip()
    base_url = payload.base_url.strip().rstrip("/")
    model_id = payload.model_id.strip()
    label = payload.label.strip() or model_id

    key_row = ProviderKey(provider=provider)
    key_row.api_key = api_key
    key_row.base_url = base_url
    db.add(key_row)

    pref = db.get(AppPreference, "custom_models")
    if pref is None:
        pref = AppPreference(key="custom_models")
        db.add(pref)
    items = _list_custom_models(db)
    items.append({
        "provider": provider,
        "label": label,
        "base_url": base_url,
        "model_id": model_id,
        "api_format": payload.api_format,
    })
    pref.value = items
    db.commit()
    return {"ok": True, "provider": provider, "model": model_id, "label": label}


@router.delete("/custom/{provider}", status_code=204)
def delete_custom_model(provider: str, db: Session = Depends(get_db)):
    """删除自定义模型：清掉 custom_models 清单项 + ProviderKey；若正被设为默认模型则一并清除。

    高级设置路由里引用了该 provider 的配置一并删除（避免路由指向已移除的模型）。
    """
    pref = db.get(AppPreference, "custom_models")
    if pref is not None and pref.value:
        items = [it for it in pref.value if it.get("provider") != provider]
        pref.value = items
    row = db.get(ProviderKey, provider)
    if row is not None:
        db.delete(row)
    for r in db.execute(select(ModelRoute).where(ModelRoute.provider == provider)).scalars().all():
        db.delete(r)
    dft = db.get(AppPreference, "default_model")
    if dft is not None and dft.value and dft.value.get("provider") == provider:
        dft.value = _pick_fallback_default(db, (provider, None))
    db.commit()


@router.get("/routes")
def get_routes(db: Session = Depends(get_db)):
    """前端下拉读此表：可用模型列表 = model_routes 已配置的行。"""
    return list_routes(db)


@router.post("/routes", response_model=RouteRead)
def upsert_route(payload: RouteUpsert, db: Session = Depends(get_db)):
    """新增路由；同 task_type 已存在则整体更新（换模型不加代码）。"""
    row = db.execute(
        select(ModelRoute).where(ModelRoute.task_type == payload.task_type)
    ).scalar_one_or_none()
    if row is None:
        row = ModelRoute(task_type=payload.task_type)
        db.add(row)
    row.provider = payload.provider
    row.model = payload.model
    row.temperature = payload.temperature
    row.max_tokens = payload.max_tokens
    row.context_window = payload.context_window
    row.is_default = payload.is_default
    db.commit()
    db.refresh(row)
    return RouteRead.model_validate(row)


@router.patch("/routes/{route_id}", response_model=RouteRead)
def update_route(route_id: uuid.UUID, payload: RouteUpsert, db: Session = Depends(get_db)):
    """按 id 更新路由的全部配置（模型/温度/上下文窗口/是否默认）。"""
    row = db.get(ModelRoute, route_id)
    if row is None:
        raise HTTPException(404, "路由不存在")
    row.provider = payload.provider
    row.model = payload.model
    row.temperature = payload.temperature
    row.max_tokens = payload.max_tokens
    row.context_window = payload.context_window
    row.is_default = payload.is_default
    db.commit()
    db.refresh(row)
    return RouteRead.model_validate(row)


@router.delete("/routes/{route_id}", status_code=204)
def delete_route(route_id: uuid.UUID, db: Session = Depends(get_db)):
    """删除路由后该任务类型回落默认模型（config 兜底），不中断任何角色。"""
    row = db.get(ModelRoute, route_id)
    if row is None:
        raise HTTPException(404, "路由不存在")
    db.delete(row)
    db.commit()


@router.post("/probe", response_model=ProbeResponse)
async def probe_models(payload: ProbeRequest):
    """验证 Key 有效性并尽量返回账号下可用模型。

    优先 GET /models 拿真实列表；订阅套餐端点（如火山 api/coding/v3、api/plan/v3）不支持
    GET /models，则用给定模型发最小 chat 请求验证 Key+模型，此时可用列表即该模型。
    """
    base_url = payload.base_url
    if base_url is None:
        # 回落：预置目录里的官方地址（不维护第二份回落表，避免过时）
        base_url = next((p["base_url"] for p in MODEL_CATALOG if p["provider"] == payload.provider), None)
    if base_url is None:
        raise HTTPException(400, f"未知 provider：{payload.provider}，请提供 base_url")

    headers = {"Authorization": f"Bearer {payload.api_key}"}
    async with httpx.AsyncClient(timeout=20) as client:
        # 1) 优先 GET /models 拿真实可用列表
        try:
            resp = await client.get(f"{base_url}/models", headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                models = [m.get("id") for m in data.get("data", []) if m.get("id")]
                if models:
                    return ProbeResponse(models=models)
            if resp.status_code in (401, 403):
                raise HTTPException(resp.status_code, f"连接失败：Key 无效或无权访问（HTTP {resp.status_code}）")
            # 其它状态（如 404/405）：端点不支持列出模型，继续走 chat 探测
        except httpx.HTTPError as e:
            raise HTTPException(502, f"连接失败：无法访问 {base_url}（{type(e).__name__}）")

        # 2) 用给定模型发最小 chat 请求验证（订阅套餐端点仅支持 /chat/completions）
        if payload.model:
            body = {
                "model": payload.model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1,
                "stream": False,
            }
            resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=body)
            if resp.status_code not in (200, 201):
                raise HTTPException(resp.status_code, f"连接失败：{resp.text[:200]}")
            return ProbeResponse(models=[payload.model])

        raise HTTPException(400, "无法探测：该端点不支持列出模型，请选择模型后重试")


class CatalogRefresh(BaseModel):
    """刷新某服务商的模型列表：用有效 Key 从服务商拉取账号下的真实模型并缓存。

    provider/base_url/api_key 必填；model 可选（订阅套餐端点不支持 GET /models 时，
    用该模型发最小 chat 请求验证并仅保留它）。刷新成功后，catalog 接口以缓存为准。
    """
    provider: str = Field(..., min_length=1)
    api_key: str = Field(..., min_length=1)
    base_url: Optional[str] = None
    model: Optional[str] = None


@router.post("/catalog/refresh")
async def refresh_catalog_models(payload: CatalogRefresh, db: Session = Depends(get_db)):
    """「刷新模型列表」：用 Key 拉取该服务商账号下的真实模型并缓存，替代静态种子目录。

    返回 {provider, models, updated_at, source}：models 为真实列表（含 label 回退），
    source 为 "live"（GET /models 拉到）或 "chat"（订阅端点，仅保留验证通过的模型）。
    无 Key 无法调用（需 Key 才能验证账号可用模型），静态目录永远作为兜底。
    """
    base_url = (payload.base_url or "").strip()
    if not base_url:
        # 回落：预置目录里的官方地址（不维护第二份回落表，避免过时）
        base_url = next((p["base_url"] for p in MODEL_CATALOG if p["provider"] == payload.provider), None)
    if not base_url:
        raise HTTPException(400, f"未知 provider：{payload.provider}，请提供 base_url")

    headers = {"Authorization": f"Bearer {payload.api_key}"}
    async with httpx.AsyncClient(timeout=20) as client:
        # 1) 优先 GET /models 拿真实可用列表
        try:
            resp = await client.get(f"{base_url}/models", headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                models = [
                    {"id": m.get("id"), "label": m.get("id")}
                    for m in data.get("data", [])
                    if m.get("id")
                ]
                if models:
                    _set_live_models(db, payload.provider, models)
                    return {
                        "provider": payload.provider,
                        "models": models,
                        "updated_at": _get_live_models(db)[payload.provider]["updated_at"],
                        "source": "live",
                    }
            if resp.status_code in (401, 403):
                raise HTTPException(resp.status_code, f"连接失败：Key 无效或无权访问（HTTP {resp.status_code}）")
            # 其它状态（如 404/405）：端点不支持列出模型，继续走 chat 验证
        except httpx.HTTPError as e:
            raise HTTPException(502, f"连接失败：无法访问 {base_url}（{type(e).__name__}）")

        # 2) 用给定模型发最小 chat 请求验证（订阅套餐端点仅支持 /chat/completions）
        if payload.model:
            body = {
                "model": payload.model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 1,
                "stream": False,
            }
            resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=body)
            if resp.status_code not in (200, 201):
                raise HTTPException(resp.status_code, f"连接失败：{resp.text[:200]}")
            models = [{"id": payload.model, "label": payload.model}]
            _set_live_models(db, payload.provider, models)
            return {
                "provider": payload.provider,
                "models": models,
                "updated_at": _get_live_models(db)[payload.provider]["updated_at"],
                "source": "chat",
            }

        raise HTTPException(400, "无法刷新：该端点不支持列出模型，请先选择模型并测试连接")
