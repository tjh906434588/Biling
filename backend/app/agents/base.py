"""Agent 统一接口：build_context / run / parse_output（技术设计 §5 通用约定）。

每个角色实现此基类；编排层（services/pipeline）顺序/并发调用，产出经 Pydantic 校验。
"""
import json
import re
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, TypeVar

from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.agents.prompt_config import CONFIGURABLE_AGENTS, build_writing_directive
from app.llm.gateway import stream_completion
from app.llm.routes import resolve_route

T = TypeVar("T", bound=BaseModel)


@dataclass
class ContextPack:
    """角色信息切片：只装该角色允许看到的内容（信息隔离白名单，见 §5 四层隔离 #1）。"""

    novel_id: uuid.UUID
    agent: str
    system_prompt: str
    messages: list[dict] = field(default_factory=list)  # OpenAI 格式 [{role, content}]
    meta: dict = field(default_factory=dict)  # 供 parse_output/入库使用的旁路信息
    truncated_components: list[str] = field(default_factory=list)  # 被 token 预算器截断的组件标注
    temperature: float = 0.7
    max_tokens: int | None = None


class Agent(ABC, Generic[T]):
    """角色基类。task_type 对应 model_routes 任务路由。"""

    task_type: str = "chat"
    temperature: float = 0.7
    version_count: int = 1
    mock_output: dict | None = None  # 无 Key 时 Mock 流的合法 JSON 样例（演示完整链路）

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

    def build_versioned_contexts(self, ctx: ContextPack) -> list[ContextPack]:
        """多版本上下文：version_count>1 时由子类产出 N 份差异化的 ContextPack（如双版本温度/风格变体）。

        默认单版本。pipeline 检测 len>1 后并行流式、分别校验、按版本入库。
        """
        return [ctx]

    def version_source(self, index: int) -> str:
        """版本落库 source 标记（novelist_A/novelist_B...），默认 novelist_A/B。"""
        return f"novelist_{'A' if index == 0 else chr(ord('A') + index)}"

    def run(self, ctx: ContextPack, *, on_reason=None):
        """流式调用 LLM。可按版本数并行（见 novelist）。
        on_reason：推理过程文字（reasoning_content）逐段回调，供"思考中"提示透传。"""
        route = resolve_route(self.db, self.task_type)
        messages = ctx.messages
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
            temperature=ctx.temperature or self.temperature,
            max_tokens=ctx.max_tokens,
            mock_output=json.dumps(self.mock_output, ensure_ascii=False) if self.mock_output else None,
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
