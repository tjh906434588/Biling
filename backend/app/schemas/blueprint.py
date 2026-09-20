"""蓝图（Blueprint）Schema：版本列表 / active 视图 / 激活归档。"""
import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class BlueprintRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    novel_id: uuid.UUID
    version: int
    parent_id: Optional[uuid.UUID]
    content: dict  # 完整蓝图对象（Blueprint schema 的 model_dump）
    status: str  # active（生效中）| inactive（未生效）
    # 导入模式生成时关联的文档名（非导入生成则为 null）；文档全文在 source_doc，体积大不回传列表
    doc_name: Optional[str] = None
    created_at: datetime


class BlueprintCheckRequest(BaseModel):
    """校验比对请求：可选覆盖源文档（蓝图没有 source_doc 时由前端传入当前导入文本）。"""
    source_doc: Optional[str] = None


class BlueprintActivateIn(BaseModel):
    """激活时可选：为新蓝图命名/备注。默认置 active 并归档旧 active。"""
    note: Optional[str] = None


class BlueprintUpdateIn(BaseModel):
    """蓝图内容部分更新：content 中出现的键覆盖蓝图现有 content 对应键，未出现的键保持不变。"""
    content: dict[str, Any] = {}
