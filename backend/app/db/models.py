"""核心数据模型（对应技术设计 §4.1 全部表）。

说明：
- UUID 主键用 SQLAlchemy 2.0 原生 Uuid 类型（SQLite/PG 通用）。
- JSONB 用 sa.JSON 表达：SQLite 原生支持，PG 部署可换 JSONB。
- embedding 在 SQLite 开发期为 NULL（无 pgvector），PG 上为 VECTOR(1024)。
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Novel(Base):
    __tablename__ = "novels"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    premise: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # 蓝图识别文风：从导入蓝图/大纲文档自动提炼，每次导入蓝图时覆盖（前端只读）
    style_directive: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # 手动添加文风：作者手动维护，导入蓝图不会覆盖；与蓝图识别文风冲突时以蓝图识别为准
    style_directive_manual: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class AgentTask(Base):
    """AI 生成任务的持久化记录：生成从 HTTP 请求生命周期解耦为后台任务。

    页面刷新 / 切页导致 SSE 断开后，后台任务继续生成并落库；
    前端刷新后通过查询接口发现 running 任务，恢复"生成中"状态并轮询到完成。
    """
    __tablename__ = "agent_tasks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    agent: Mapped[str] = mapped_column(String(64), index=True)  # blueprint_architect / ...
    status: Mapped[str] = mapped_column(String(16), default="running")  # running|done|error
    params: Mapped[Optional[dict]] = mapped_column(JSON)  # 生成入参（含 import_source / doc_name 等）
    msg: Mapped[Optional[str]] = mapped_column(Text)  # 最近状态提示（如已落库）
    error: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Setting(Base):
    """设定条目（统一表 + type 区分）。"""
    __tablename__ = "settings"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    type: Mapped[str] = mapped_column(String(32), index=True)  # character|location|faction|world_rule|item|concept
    name: Mapped[str] = mapped_column(String(255))
    # 数据来源（隐藏字段，不展示界面）：blueprint（蓝图导入，按版本存储）| batch（设定页批量新增）| manual（单个新增/其他）| outline（大纲批准时注入，随批准版本切换显示/隐藏）
    source: Mapped[str] = mapped_column(String(16), default="manual", server_default="manual")
    # 所属蓝图版本：source="blueprint" 的设定记录导入它的蓝图；激活哪个蓝图就显示哪个蓝图的设定，其余版本隐藏保留（可切回）
    blueprint_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, ForeignKey("blueprints.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 所属大纲版本（多值）：source="outline" 的设定记录注入它的各章大纲版本（第几章第几个版本，可跨章多个）；
    # 只要任一来源版本仍是「该章当前批准版」，该设定即可见；全部来源不再批准时才隐藏
    # （不删除，切回任意来源版本即恢复，无需重新提取）
    outline_ids: Mapped[Optional[list]] = mapped_column(JSON)  # list[str] outline.id，隐形字段不展示
    description: Mapped[Optional[str]] = mapped_column(Text)
    structured: Mapped[Optional[dict]] = mapped_column(JSON)  # 按 type 的字段（appearance/personality/goals/relations...）
    is_constitution: Mapped[bool] = mapped_column(Boolean, default=False)  # 小说宪法：不可变硬约束
    embedding: Mapped[Optional[list]] = mapped_column(JSON)  # SQLite 开发期 NULL；PG 用 VECTOR(1024)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    aliases: Mapped[Optional[list]] = mapped_column(JSON)  # M2 增强：别名表（检索/抽取按别名归一）
    merged_into_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)  # 分身合并：指向主条目


class ConceptCard(Base):
    """概念卡片（概念师从对话抽取的沉淀物，pending→confirmed→integrated）。"""
    __tablename__ = "concept_cards"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    raw_text: Mapped[str] = mapped_column(Text)  # 用户原话
    extracted: Mapped[Optional[dict]] = mapped_column(JSON)  # 结构化抽取结果
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|confirmed|rejected|integrated
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Blueprint(Base):
    """蓝图（版本化，version 链）。"""
    __tablename__ = "blueprints"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    parent_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, nullable=True)  # 版本链
    content: Mapped[dict] = mapped_column(JSON)  # 完整蓝图对象
    status: Mapped[str] = mapped_column(String(16), default="inactive")  # active|inactive（生效中|未生效）
    # 导入模式：生成该版本时使用的导入文档全文 + 文件名（校验比对 / 溯源用；非导入生成则为 NULL）
    source_doc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    doc_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class BlueprintStyle(Base):
    """蓝图识别文风（按蓝图版本存储）：导入蓝图时提炼的全局文风，激活哪个蓝图就用哪个的文风。

    novel.style_directive 始终等于「当前生效蓝图的文风」，激活切换 / 自动激活时由服务层同步；
    其余蓝图的文风按本表按版本保留，切回时直接恢复，无需重新提炼。
    """
    __tablename__ = "blueprint_styles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    blueprint_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("blueprints.id", ondelete="CASCADE"), unique=True, index=True
    )
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    directive: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Outline(Base):
    """章节大纲（同一章可存多个版本，version_no 递增；批准版是下游唯一依据）。"""
    __tablename__ = "outlines"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    blueprint_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, ForeignKey("blueprints.id"), nullable=True)
    chapter_no: Mapped[int] = mapped_column(Integer, index=True)
    version_no: Mapped[int] = mapped_column(Integer, default=1)  # 同章版本号，生成新大纲时递增
    title: Mapped[Optional[str]] = mapped_column(String(255))
    content: Mapped[dict] = mapped_column(JSON)  # goal/chapter_function/beats/pov/characters/locations/conflicts/plant/resolve/thread_updates
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|approved（同章最多一个 approved）
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PlotLedger(Base):
    """伏笔账本（所有钩子；含紧迫度与超期检测）。"""
    __tablename__ = "plot_ledger"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    item_type: Mapped[str] = mapped_column(String(24))  # setup|thread|character_state|location_state|unresolved_hook
    description: Mapped[str] = mapped_column(Text)
    related_entity: Mapped[Optional[str]] = mapped_column(String(255))
    chapter_introduced: Mapped[Optional[int]] = mapped_column(Integer)
    chapter_resolved: Mapped[Optional[int]] = mapped_column(Integer)
    urgency: Mapped[Optional[int]] = mapped_column(Integer)  # 紧迫度 1-10
    target_reveal_chapter: Mapped[Optional[int]] = mapped_column(Integer)  # 计划揭示章节
    status: Mapped[str] = mapped_column(String(16), default="open")  # open|closed|abandoned
    confidence: Mapped[str] = mapped_column(String(8), default="high")  # high|medium|low
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    since_chapter: Mapped[Optional[int]] = mapped_column(Integer)  # M2 增强：本条状态生效起始章
    invalidated_at_chapter: Mapped[Optional[int]] = mapped_column(Integer)  # 失效章（as-of 查询用）
    # 数据来源（隐形字段，不展示界面）：outline（大纲批准时注入，按来源版本切换显示/隐藏）| extractor（提取师）| manual（手动登记）
    source: Mapped[str] = mapped_column(String(16), default="outline", server_default="outline")
    # 来源大纲版本（source="outline" 时记录登记它的大纲版本 id；隐形字段不展示，随版本切换隐藏未批准）
    outline_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, ForeignKey("outlines.id"), nullable=True, index=True
    )


class Chapter(Base):
    """章节（正式版正文）。"""
    __tablename__ = "chapters"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    outline_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, ForeignKey("outlines.id"), nullable=True)
    chapter_no: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[Optional[str]] = mapped_column(String(255))
    content: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|complete
    word_count: Mapped[Optional[int]] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class ChapterVersion(Base):
    """章节版本（双版本通过此表表达）。"""
    __tablename__ = "chapter_versions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    chapter_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("chapters.id"), index=True)
    version_no: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(24))  # novelist_A|novelist_B|user_edit|merged
    title: Mapped[Optional[str]] = mapped_column(String(255))  # 该版本自己的标题（草稿可各自不同，定稿时同步回章）
    content: Mapped[str] = mapped_column(Text)
    note: Mapped[Optional[str]] = mapped_column(Text)  # 生成自评（用到设定/待回收伏笔）
    outline_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, ForeignKey("outlines.id"), nullable=True, index=True
    )  # 该版本正文所用的大纲版本（同章不同版本内容可能不同，关联精确到版本）
    parent_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, nullable=True, index=True
    )  # 版本树父节点：新增章节/重新生成正文=根（null）；评价优化（reviser）= 被优化版本 → 多级树
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class StoryState(Base):
    """故事状态快照（提取师产出，每章一条）。"""
    __tablename__ = "story_state"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    chapter_no: Mapped[int] = mapped_column(Integer, index=True)
    chapter_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, ForeignKey("chapter_versions.id"), nullable=True
    )  # 提取时对应的正文版本（用于「当前版本是否已提取」判断）
    summary: Mapped[str] = mapped_column(Text)  # 120 字摘要
    key_events: Mapped[Optional[list]] = mapped_column(JSON)
    character_states: Mapped[Optional[list]] = mapped_column(JSON)
    world_state_changes: Mapped[Optional[list]] = mapped_column(JSON)
    new_foreshadowing: Mapped[Optional[list]] = mapped_column(JSON)
    resolved_foreshadowing: Mapped[Optional[list]] = mapped_column(JSON)
    unresolved_hooks: Mapped[Optional[list]] = mapped_column(JSON)
    next_chapter_implications: Mapped[Optional[list]] = mapped_column(JSON)
    since_chapter: Mapped[Optional[int]] = mapped_column(Integer)  # M2 增强：快照生效起始章
    invalidated_at_chapter: Mapped[Optional[int]] = mapped_column(Integer)  # 失效章（as-of 查询用，不删除）
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EntityRelation(Base):
    """实体图谱（M4）：实体之间的关系（dynamic=剧情层，由提取师自动抽取）。"""

    __tablename__ = "entity_relations"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    source: Mapped[str] = mapped_column(String(255))  # 源实体名
    target: Mapped[str] = mapped_column(String(255))  # 目标实体名
    relation: Mapped[str] = mapped_column(String(64))  # 关系标签（如 盟友/敌对/所属/出现在）
    type: Mapped[str] = mapped_column(String(16), default="dynamic")  # dynamic=剧情层（提取师自动抽取）；static 已废弃无来源
    chapter_no: Mapped[Optional[int]] = mapped_column(Integer)  # dynamic 关系的发生章
    confidence: Mapped[str] = mapped_column(String(8), default="high")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)  # 手动标记失效（被新关系取代），展示灰显保留历史、注入跳过
    superseded_by_chapter: Mapped[Optional[int]] = mapped_column(Integer)  # 被哪一章取代（取代者所在章，精确定位取代链用）
    superseded_by_relation: Mapped[Optional[str]] = mapped_column(Text)  # 取代者的关系名（同 source/target，与 superseded_by_chapter 一起唯一定位取代者行）
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class StyleProfile(Base):
    """风格画像（版本化，随用户编辑迭代）。"""
    __tablename__ = "style_profiles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    traits: Mapped[Optional[dict]] = mapped_column(JSON)  # 句式/词汇/视角/节奏偏好 + 示例片段
    avoid_list: Mapped[Optional[list]] = mapped_column(JSON)  # 用户多次拒绝的写法
    source_diff_ids: Mapped[Optional[list]] = mapped_column(JSON)  # 引用产生本次学习的编辑 diff
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class QualityReview(Base):
    """质量账本（评价师产出）。"""
    __tablename__ = "quality_reviews"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    chapter_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, ForeignKey("chapter_versions.id"))
    overall_score: Mapped[Optional[int]] = mapped_column(Integer)
    rubric: Mapped[Optional[dict]] = mapped_column(JSON)  # 分维度 {score, comment, evidence}
    issues: Mapped[Optional[list]] = mapped_column(JSON)  # [{severity, type, desc, suggested_fix, ledger_ref?}]
    strengths: Mapped[Optional[list]] = mapped_column(JSON)
    revision_hints: Mapped[Optional[list]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class ModelRoute(Base):
    """模型路由配置（运行时可改，换模型不改代码）。"""
    __tablename__ = "model_routes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    task_type: Mapped[str] = mapped_column(String(16), index=True)  # setting|creation|review|extract|chat
    provider: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(128))
    temperature: Mapped[Optional[float]] = mapped_column(Float)
    max_tokens: Mapped[Optional[int]] = mapped_column(Integer)
    context_window: Mapped[Optional[int]] = mapped_column(Integer)  # token 预算器按此动态装配
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class ProviderKey(Base):
    """页面配置的 provider API Key（开发期明文存 SQLite；部署可换加密存储）。

    保存后 gateway 实时读取，无需改 .env / 重启。
    """

    __tablename__ = "provider_keys"

    provider: Mapped[str] = mapped_column(String(64), primary_key=True)  # deepseek/openai/qwen/...
    api_key: Mapped[str] = mapped_column(Text)
    base_url: Mapped[Optional[str]] = mapped_column(Text)  # 可选：自定义网关 / 中转地址
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class AppPreference(Base):
    """应用级键值配置（页面设置，如 default_model）。"""

    __tablename__ = "app_preferences"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Optional[dict]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class DetectorConfig(Base):
    """AI 生成检测配置（可选，体检性质；不设硬阈值不阻断写作）。"""
    __tablename__ = "detector_config"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    backend: Mapped[str] = mapped_column(String(24), default="local_heuristic")  # local_heuristic|local_model|zhuque_api
    api_key: Mapped[Optional[str]] = mapped_column(Text)
    base_url: Mapped[Optional[str]] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class PromptTemplate(Base):
    """提示词模板（存库可配置，M4 提供后台编辑接口）。"""
    __tablename__ = "prompts"
    __table_args__ = (UniqueConstraint("key", "scope", name="uq_prompts_key_scope"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String(64), index=True)  # system_writing_l1 / novelist / critic...
    scope: Mapped[str] = mapped_column(String(16), default="global")  # global|novel:{novel_id}
    content: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
