"""Agent 统一接口：build_context / run / parse_output。

每个角色实现此基类；编排层（services/pipeline）顺序/并发调用，产出经 Pydantic 校验。
"""
import json
import logging
import re
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Optional, TypeVar

from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.agents.prompt_config import CONFIGURABLE_AGENTS, build_writing_directive
from app.llm.gateway import stream_completion
from app.llm.routes import resolve_route

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# 组件优先级（越大越不可裁剪）：硬约束类 > 写作基础类 > 记忆/设定类 > 可牺牲类。
# token 预算器按此从低到高剔除组件，直到上下文不超窗。
PRIORITY_REQUIRED = 100  # 硬约束（项目/背景/题材/必现清单/作者否决等）：预算再紧也不裁
PRIORITY_BASE = 90  # 蓝图/大纲/节奏指令：写作的基础参照
PRIORITY_MEMORY = 70  # 前文记忆/角色状态：保持连贯性
PRIORITY_SETTING = 60  # 设定库/关系图谱/伏笔账本：可裁剪但尽量给
PRIORITY_CONTEXT = 40  # 最近章节全文：最占空间，预算紧张时最先裁
PRIORITY_STYLE = 30  # 风格画像等辅助信息：最后给


@dataclass
class ComponentBlock:
    """上下文的一个可裁剪组件块（token 预算器按 priority 决定保留/剔除）。"""

    key: str  # 组件名（截断时记入 truncated_components，供前端/日志观察）
    content: str  # 该块文本（不含块间分隔，拼接时统一用空行分隔）
    priority: int = PRIORITY_MEMORY


@dataclass
class ContextPack:
    """角色信息切片：只装该角色允许看到的内容（信息隔离白名单）。"""

    novel_id: uuid.UUID
    agent: str
    system_prompt: str
    messages: list[dict] = field(default_factory=list)  # OpenAI 格式 [{role, content}]
    meta: dict = field(default_factory=dict)  # 供 parse_output/入库使用的旁路信息
    components: list[ComponentBlock] = field(default_factory=list)  # 可裁剪组件（token 预算器按此动态装配）
    truncated_components: list[str] = field(default_factory=list)  # 被 token 预算器截断的组件标注
    temperature: float = 0.7
    max_tokens: int | None = None


class Agent(ABC, Generic[T]):
    """角色基类。task_type 对应 model_routes 任务路由。"""

    # task_type 对应 model_routes 任务路由；具体角色都必须显式指定，这里只是兜底默认
    task_type: str = "setting"
    temperature: float = 0.7
    # 温度是否固定用本 agent 默认值（不走路由配置）。默认 False = 路由配置的温度优先；
    # 少数任务（如修订师，需稳定输出）设 True，避免被同 task_type 的高温（如创作 0.8）带偏。
    temperature_fixed: bool = False

    def __init__(self, db: Session):
        self.db = db

    # ---------- 必实现 ----------

    @abstractmethod
    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        """装配该角色可见的上下文（读记忆层 + 组装 system prompt）。"""

    @abstractmethod
    def parse_output(self, text: str) -> T:
        """把流式文本解析为结构化产出（Pydantic 校验）。"""

    # ---------- 默认实现 ----------

    def run(self, ctx: ContextPack, *, on_reason=None):
        """流式调用 LLM。
        on_reason：推理过程文字（reasoning_content）逐段回调，供"思考中"提示透传。"""
        from app.agents.context import apply_token_budget, assemble_components

        route = resolve_route(self.db, self.task_type)
        messages = ctx.messages
        # token 预算器：按模型 context_window 裁剪组件（硬约束不裁），裁剪后重新拼装
        # user_content 替换 user 消息（预算充足时拼装结果与 build_context 一致）
        if ctx.components:
            apply_token_budget(ctx, route.context_window)
            user_content = assemble_components(ctx.components)
            for i, m in enumerate(messages):
                if m.get("role") == "user":
                    messages[i] = {**m, "content": user_content}
                    break
            if ctx.truncated_components:
                logger.warning(
                    "[budget] agent=%s 上下文超窗，剔除组件 %s（剩余 %s 个）",
                    ctx.agent,
                    ctx.truncated_components,
                    len(ctx.components),
                )
        # 每部小说独立的可配置写作指令：创作/评审角色在 system 消息末尾追加自定义块（未配置注入内置默认，已配置只注入非空字段）
        if ctx.agent in CONFIGURABLE_AGENTS:
            directive = build_writing_directive(self.db, ctx.novel_id, ctx.agent)
            if directive:
                for i, m in enumerate(messages):
                    if m.get("role") == "system":
                        messages[i] = {**m, "content": f"{m['content']}\n\n{directive}"}
                        break
        return stream_completion(
            messages,
            route,
            # 温度优先级：temperature_fixed=True 的任务（如修订师）固定用 agent 默认，稳定优先；
            # 否则：用户在该任务类型的 model_routes 里配置的温度 > 本次调用 ctx 温度 > agent 默认
            # （route.temperature 已保留 None 表示未配置，见 resolve_route）
            temperature=(
                self.temperature
                if self.temperature_fixed
                else (route.temperature if route.temperature is not None else (ctx.temperature or self.temperature))
            ),
            max_tokens=ctx.max_tokens,
            mock_output=None,
            db=self.db,
            on_reason=on_reason,
        )

    def validate(self, text: str) -> T:
        """产出校验（硬约束：失败即抛出，由编排层触发自纠错重试）。"""
        t = text.strip()
        # 容错：模型偶尔把 JSON 包在 ```json ... ``` 代码块里，剥掉再解析，避免整段判失败
        if t.startswith("```"):
            t = re.sub(r"^```[a-zA-Z]*\s*\n?", "", t).strip()
            t = re.sub(r"\n?```\s*$", "", t).strip()
        try:
            return self.parse_output(t)
        except (ValidationError, ValueError, json.JSONDecodeError):
            # 最后兜底：模型输出可能夹杂前后说明文字（如"好的，结果如下：{...} 请查收"），
            # 截取首个 { 到末个 } 之间的 JSON 片段再解析；仍失败则抛原始错误走自纠错重试
            start = t.find("{")
            end = t.rfind("}")
            if start != -1 and end > start:
                try:
                    return self.parse_output(t[start : end + 1])
                except (ValidationError, ValueError, json.JSONDecodeError):
                    pass
            raise

    def host_validate(self, parsed: T, params: dict, meta: Optional[dict] = None) -> None:
        """宿主侧校验（默认 no-op）：schema 校验通过后，对产出做「不需要 LLM 的确定性检查」。

        子类可覆盖：校验产出的证据引用是否真实存在于上下文（防编造引文）、
        引用是否与输入矛盾等。失败抛 ValueError（携带可读错误信息），
        由编排层并入自纠错重试流程（与 schema 失败同路径，最多重试一次）。
        meta：build_context 的 ContextPack.meta（含 params 与各角色旁路数据）。
        """
        return None
