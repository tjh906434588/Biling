"""章节 Schema：列表 / 详情 / 版本选定。"""
import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class ChapterVersionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version_no: int
    source: str
    title: Optional[str] = None  # 该版本自己的标题（草稿各自独立，供版本列表/正文区展示）
    content: str
    note: Optional[str]
    outline_id: Optional[uuid.UUID] = None  # 该版本所用大纲版本
    parent_version_id: Optional[uuid.UUID] = None  # 版本树父节点 id（null=根：新增/重新生成；非 null=评价优化产物）
    is_active: bool
    # 签约未过签：最新评价存在 severity=high 的红线 issue（内容红线/抄袭）→ True，
    # 定稿默认被拒；评价更新后自动重算。null=该版本尚无评价（未检查过）
    signing_blocked: Optional[bool] = None
    created_at: datetime


class ChapterListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    chapter_no: int
    title: Optional[str]
    status: str
    word_count: Optional[int]
    updated_at: datetime
    active_source: Optional[str] = None  # 当前激活版本来源（novelist_A/merged/...）
    active_content: Optional[str] = None  # 激活版本正文（阅读/续写用）
    extracted_version_id: Optional[uuid.UUID] = None  # 该章提取入记忆层时对应的正文版本（未提取过为 None）


class ChapterDetail(BaseModel):
    chapter_no: int
    title: Optional[str]
    status: str
    versions: list[ChapterVersionRead]


class SelectVersionRequest(BaseModel):
    version_id: uuid.UUID
    force: bool = False  # 越过签约未过签拦截强制定稿（作者权威逃生口）


class ReviewRead(BaseModel):
    """质量账本（评价师产出）读取：rubric/issues 为原始 JSON。

    带出评价所针对的**正文版本**，前端据此判断这条评价是否已过期
    （正文已被后续版本取代，评价不再对得上）。
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    chapter_no: Optional[int] = None
    chapter_title: Optional[str] = None
    chapter_version_id: Optional[uuid.UUID] = None
    version_no: Optional[int] = None  # 评价所针对的版本号
    version_source: Optional[str] = None  # novelist|reviser|merged…
    is_current: bool = False  # 该版本是否为本章当前激活版本（正文对得上才算数）
    overall_score: Optional[int]
    rubric: Optional[dict]
    issues: Optional[list]
    strengths: Optional[list]
    revision_hints: Optional[list]
    created_at: datetime
