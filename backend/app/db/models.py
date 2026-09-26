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
    # 世界背景类型（可留空不选，导入蓝图时由 AI 按素材推断、作者确认后落库）：
    # realistic=现实年代（有真实世界参照，签约核查需对照真实时代细节）
    # | alternate=半架空（现实框架+虚构元素，虚构部分以设定账本为准）| pure_fantasy=纯架空（无现实参照，
    # 一切以设定账本为唯一事实源，禁止用真实世界规则判定正文错误）
    background_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    # 题材多选（如 ["都市","重生"]）：软性写作方向指引（区别于 background_type 的硬性核查口径）。
    # 复合题材天然支持多选；注入生成/评价 agent 作为"往哪方面下手"的指引
    genres: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    # 时代行业研究（运行时按需生成，非代码内置）：LLM 按本小说的"年代×行业"现场研究，
    # 产出机构形态/老板画像/业务清单/位置规律/行业演进/时代错位雷点，供设定生成与评价复用；
    # 换一本小说自动重新研究，不依赖开发加知识包。作者可在项目设置页查看/修改。
    era_research: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
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


class AuthorConfirm(Base):
    """作者确认请求（生成流程内的暂停点）。

    生成 agent 遇到「需要作者定夺」的岔路口（如大纲下一步发展脉络方向、时代研究结论、背景×题材
    校验）时，落一条 pending 确认请求并暂停等待；前端轮询/SSE 事件发现后弹窗展示 3 个 AI 提案选项
    + 自定义输入框，作者提交后生成任务恢复继续。刷新/断线不丢——请求持久化在库，恢复时重查。
    """
    __tablename__ = "author_confirms"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    agent: Mapped[str] = mapped_column(String(64), index=True)  # 请求确认的 agent：outliner / era_researcher / ...
    task_id: Mapped[Optional[uuid.UUID]] = mapped_column(Uuid, ForeignKey("agent_tasks.id"), nullable=True, index=True)
    # 确认点标识（同一 agent 同一确认点在任务内唯一），用于恢复时精确定位 & 防止重复弹窗
    confirm_key: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|answered|dismissed
    question: Mapped[str] = mapped_column(Text)  # 咨询问题（展示给作者）
    options: Mapped[Optional[list]] = mapped_column(JSON)  # [{id, label, desc}] AI 提案选项（如 3 个故事方向）
    # 场景卡片确认（场景规划）：fields = [{field, label, hint, options: 5 个候选}]，一个场景 5 个字段；
    # 存在时前端按「场景卡片」渲染（逐字段单选+自定义），答案回传 field_answers
    fields: Mapped[Optional[list]] = mapped_column(JSON)
    allow_custom: Mapped[bool] = mapped_column(Boolean, default=True)  # 是否允许作者自定义输入
    # 场景写法提案确认（scene_proposal）为 True：前端额外提供「都不满意，重新生成」按钮（回传 __regenerate__）
    regenerable: Mapped[bool] = mapped_column(Boolean, default=False)
    # 作者提交的答案：命中选项存选项 id；自定义输入存原文；dismissed 存 NULL
    answer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    answer_meta: Mapped[Optional[dict]] = mapped_column(JSON)  # {label, note} 选中的选项 label + 作者补充说明
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    answered_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Setting(Base):
    """设定条目（统一表 + type 区分）。"""
    __tablename__ = "settings"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    type: Mapped[str] = mapped_column(String(32), index=True)  # character|location|faction|world_rule|item|concept
    name: Mapped[str] = mapped_column(String(255))
    # 数据来源（隐藏字段，不展示界面）：blueprint（蓝图导入，按版本存储）| batch（设定页批量新增）| manual（单个新增/其他）| outline（大纲批准时注入，随批准版本切换显示/隐藏）| extraction（正文提取，首次登场即建档）
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
    # 关键信息固化（C）：AI 判定为关键时置 True；注入时不受设定库数量上限影响，永远进窗口（防止早期关键设定被新设定挤出）
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
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
    # 关键信息固化（C）：大纲师判定 importance=high 的伏笔置 True；注入时不受账本 20 条上限影响，
    # 永远进窗口（防止早期重要伏笔被挤出——账本超上限时最先被丢掉的就是最老的一批）
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
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
    # 作者对本章的历史修改意见（意见持久化）：评价优化时提交的 author_note 落库，
    # 后续重新生成/规划/续写本章时自动注入给 AI，防止"说过突兀还照写"。list[{text, version_no, created_at}]
    author_directives: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
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
    # 签约未过签标记：最新评价存在 severity=high 的签约红线类 issue（内容红线/抄袭）时为 True，
    # 定稿（select_version）默认拒绝；评价更新后自动重算，通过后自动解除
    signing_blocked: Mapped[bool] = mapped_column(Boolean, default=False)
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


class NovelMemory(Base):
    """作品编年总览（记忆层最上层，每 N 章由编年师生成一次，token 固定注入）。

    解决长篇"早期记忆丢失"：最近章节全文/摘要窗口只覆盖近几章，早期情节靠设定库/
    关系图谱/伏笔账本沉淀；编年把「主线进展、各卷目标、主角目标、已埋伏笔、重大设定、
    未完线索」压缩成一份固定大小的总览，长期注入所有生成/评价 agent——窗口外的关键
    信息不会因窗口滑动而失忆。
    """

    __tablename__ = "novel_memories"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    novel_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("novels.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)  # 每次重新生成递增
    up_to_chapter: Mapped[int] = mapped_column(Integer)  # 编年覆盖到第几章
    # 结构化编年：{main_line, volumes_progress, character_goals, active_foreshadowing,
    #   established_world, open_threads, next_direction}
    content: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


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
    chapter_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, ForeignKey("chapter_versions.id"), nullable=True
    )  # dynamic 关系对应的正文版本（注入时须等于该章当前激活版本，防止版本切换后残留旧版人物关系）
    confidence: Mapped[str] = mapped_column(String(8), default="high")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)  # 手动标记失效（被新关系取代），展示灰显保留历史、注入跳过
    superseded_by_chapter: Mapped[Optional[int]] = mapped_column(Integer)  # 被哪一章取代（取代者所在章，精确定位取代链用）
    superseded_by_relation: Mapped[Optional[str]] = mapped_column(Text)  # 取代者的关系名（同 source/target，与 superseded_by_chapter 一起唯一定位取代者行）
    superseded_by_version: Mapped[Optional[uuid.UUID]] = mapped_column(
        Uuid, ForeignKey("chapter_versions.id"), nullable=True
    )  # 取代者提取时所在的正文版本（切回旧版本时据此「复活」被取代的旧关系，消除取代链跨版本空档）
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
