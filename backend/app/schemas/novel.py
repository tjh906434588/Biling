"""小说项目与设定条目 Schema。"""
import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class NovelCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    premise: Optional[str] = None
    # 世界背景类型（可留空）：realistic=现实年代 | alternate=半架空 | pure_fantasy=纯架空
    # （签约核查口径按类型切换）；不确定可不选，导入蓝图时 AI 按素材推断、作者确认后落库
    background_type: Optional[str] = Field(default=None, pattern="^(realistic|alternate|pure_fantasy)$")
    # 题材多选（软性写作方向指引，区别于 background_type 硬性核查口径）：如 ["都市","重生"]，复合题材可多选
    genres: Optional[list[str]] = None


class NovelUpdate(BaseModel):
    """PATCH 小说：字段可选，传什么改什么。"""
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    premise: Optional[str] = None
    background_type: Optional[str] = Field(default=None, pattern="^(realistic|alternate|pure_fantasy)$")
    genres: Optional[list[str]] = None
    # 蓝图识别文风：导入蓝图时自动覆盖，前端不可手动改（只读）
    style_directive: Optional[str] = None
    # 手动添加文风：作者手动维护，导入蓝图不会覆盖
    style_directive_manual: Optional[str] = None
    # 时代行业研究（运行时按需生成，作者可改）：机构形态/老板画像/业务/演进/时代雷点
    era_research: Optional[dict] = None


class NovelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    premise: Optional[str]
    # 可为空：未选择（不确定可不选，导入蓝图时 AI 推断、作者确认后落库）
    background_type: Optional[str] = None
    genres: Optional[list[str]] = None
    style_directive: Optional[str]
    style_directive_manual: Optional[str]
    era_research: Optional[dict]
    created_at: datetime
    updated_at: datetime


class SettingCreate(BaseModel):
    type: str = Field(..., pattern="^(character|location|faction|world_rule|item|concept)$")
    name: str = Field(..., min_length=1, max_length=255)
    # 数据来源（隐藏字段，不展示界面）：blueprint 蓝图导入 | batch 设定页批量新增 | manual 单个新增
    source: str = Field(default="manual", pattern="^(blueprint|batch|manual)$")
    description: Optional[str] = None
    structured: Optional[dict] = None
    is_constitution: bool = False


class SettingUpdate(BaseModel):
    """PATCH 设定：所有字段可选，传什么改什么。"""
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    structured: Optional[dict] = None
    is_constitution: Optional[bool] = None


class SettingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    novel_id: uuid.UUID
    type: str
    name: str
    source: str
    # 所属蓝图版本（source="blueprint" 的设定记录导入它的蓝图；手动/批量设定为 None）
    blueprint_id: Optional[uuid.UUID] = None
    description: Optional[str]
    structured: Optional[dict]
    is_constitution: bool
    created_at: datetime
