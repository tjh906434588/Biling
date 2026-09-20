"""实体图谱（M4）Schema：图谱视图 / 关系查询 / 标记失效。"""
import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class RelationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    novel_id: uuid.UUID
    source: str
    target: str
    relation: str
    type: str
    chapter_no: Optional[int]
    confidence: str
    archived: bool
    created_at: datetime


class GraphNode(BaseModel):
    id: str  # 实体名
    label: str
    kind: str = "entity"  # character|location|faction|world_rule|item|concept|other
    group: int = 1
    role_rank: Optional[str] = None  # 角色分级：protagonist|major|minor（势力/其他为 None）


class GraphEdge(BaseModel):
    id: uuid.UUID  # entity_relations 行 id
    source: str
    target: str
    label: str  # relation
    type: str  # dynamic
    confidence: str
    chapter_no: Optional[int] = None  # 最新确立的章（跨章重复时取最新一条）


class GraphView(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
