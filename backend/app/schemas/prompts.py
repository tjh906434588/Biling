"""写作指令（prompts）Schema：结构化字段 / 更新入参 / 读取响应。"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class PromptUpdateIn(BaseModel):
    """写入某角色的结构化写作指令；字段留空 = 该字段不传给 AI（保存的空值，非默认回退）。"""

    mindset: str = ""
    style_rules: str = ""
    forbidden: str = ""
    check_standard: str = ""


class AgentPromptRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str  # 角色 key（novelist / outliner / critic / reviser / blueprint_architect）
    name: str  # 中文名
    configured: bool  # 是否有自定义记录（false = 当前为内置默认值）
    fields: dict[str, str]  # 当前生效字段：未配置时为内置默认值；已配置时为保存内容（含空字段）
    updated_at: Optional[datetime] = None
