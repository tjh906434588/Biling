"""伏笔账本（PlotLedger）Schema：读取 / 更新 / 超期视图。"""
import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class LedgerUpdate(BaseModel):
    """PATCH 账本：传什么改什么。"""
    description: Optional[str] = None
    related_entity: Optional[str] = None
    urgency: Optional[int] = Field(default=None, ge=1, le=10)
    target_reveal_chapter: Optional[int] = Field(default=None, ge=1)
    status: Optional[str] = Field(default=None, pattern="^(open|closed|abandoned)$")


class LedgerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    novel_id: uuid.UUID
    item_type: str
    description: str
    related_entity: Optional[str]
    chapter_introduced: Optional[int]
    chapter_resolved: Optional[int]
    urgency: Optional[int]
    target_reveal_chapter: Optional[int]
    status: str
    confidence: str
    created_at: datetime
    overdue: bool = False  # 由 API 层按当前进度计算（open 且超出 target_reveal_chapter）
    stale: bool = False  # 由 API 层计算（open 且引入 >=5 章仍未回收，久未处理）


class OutlineRead(BaseModel):
    """章节大纲（大纲师产出，落 outlines 表）。"""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    novel_id: uuid.UUID
    chapter_no: int
    title: Optional[str]
    content: dict
    status: str  # draft|approved
    created_at: datetime
