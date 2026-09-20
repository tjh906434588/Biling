"""概念卡片（ConceptCard）Schema：列表 / 确认转正 / 拒绝。"""
import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class ConceptCardRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    novel_id: uuid.UUID
    raw_text: str
    extracted: Optional[dict]  # ConceptItem 的 model_dump
    status: str  # pending|confirmed|rejected|integrated
    created_at: datetime


class ConceptConfirmResult(BaseModel):
    """confirm 结果：卡片状态 + 转正的设定条目。"""
    card_id: uuid.UUID
    status: str
    settings_created: list[dict]
    skipped: list[str]  # 已存在同名设定的跳过项
