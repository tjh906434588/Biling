"""风格学习（§9）Schema：diff 输入 / 画像版本 / 学习结果。"""
import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class StyleDiff(BaseModel):
    """用户对 AI 成稿的一处手动修改（句子级 diff）。"""
    id: str  # 前端 diff 标识（作为 source_diff_ids 引用）
    original: str = Field(..., min_length=1)
    edited: str = Field(..., min_length=1)


class StyleLearnIn(BaseModel):
    diffs: list[StyleDiff] = Field(..., min_length=1)


class StyleTraits(BaseModel):
    """画像 traits：句式/词汇/视角/节奏偏好 + 示例片段（§9）。"""
    sentence_length: str = "（未标注）"  # 如"短句为主，平均 8-15 字"
    vocabulary: str = "（未标注）"  # 用词倾向（口语化/书面/网络词/意象词）
    perspective: str = "（未标注）"  # 视角与叙述距离
    dialogue_ratio: str = "（未标注）"  # 对话 vs 描写比例偏好
    rhythm: str = "（未标注）"  # 节奏/段落结构偏好
    example_fragment: str = "（未标注）"  # 最能代表用户笔触的示例片段（直接摘自改文）


class StyleLearningOutput(BaseModel):
    traits: StyleTraits
    avoid_list: list[str] = []  # 用户多次拒绝/明显改掉的写法


class StyleProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    novel_id: uuid.UUID
    version: int
    traits: Optional[dict]
    avoid_list: Optional[list]
    source_diff_ids: Optional[list]
    updated_at: datetime


class StyleLearnResult(BaseModel):
    version: int
    traits: dict
    avoid_list: list[str]
    source_diff_ids: list[str]
