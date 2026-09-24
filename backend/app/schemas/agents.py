"""六角色输入/输出 Schema（对应技术设计 §5 各角色输出协议）。"""
import uuid
from typing import Optional, Union

from pydantic import BaseModel, Field, field_validator

# ---------- 概念师 ----------


class ConceptItem(BaseModel):
    # type 与设定库类型（Setting.type）一一对应，保证确认转正时一定可以落库
    type: str = Field(..., pattern="^(character|location|faction|world_rule|item|concept)$")
    name: str
    raw_quote: str
    extracted: dict
    conflicts_with_existing: list[str] = []
    questions_to_ask: list[str] = []
    # 关键信息固化（C）：importance=high 的设定转正为设定库时打 is_pinned，注入不受数量上限影响（长期关键设定永远进窗口）
    importance: str = Field(default="medium", pattern="^(high|medium|low)$")


class ConceptExtraction(BaseModel):
    concepts: list[ConceptItem]
    follow_up_questions: list[str] = []


# ---------- 蓝图师 ----------


class WorldRule(BaseModel):
    name: str
    detail: str
    constraints: list[str] = []


class CharacterArc(BaseModel):
    character: str
    # 性格/特质（材料未明确给出可省略；主角等核心角色务必收录）
    personality: Optional[str] = None
    start: str
    end: str
    turning_points: list[str] = []


class Volume(BaseModel):
    no: int
    name: str
    focus: str
    chapters_range: str
    # 本卷体量（如 "25万字"），导入的大纲文档如有明确规划则保留
    word_count: Optional[str] = None
    # 本卷章数（如 "85章"），导入的大纲文档如有明确规划则保留
    chapter_count: Optional[str] = None


class ForeshadowingPlan(BaseModel):
    plant_chapter: int
    payoff_chapter: int
    desc: str


class BlueprintConflict(BaseModel):
    """导入模式：大纲文档与设定库不一致的记录（正常生成模式恒为空）。"""
    item: str
    doc_content: str = ""
    settings_content: str = ""
    resolution: str = ""


class Blueprint(BaseModel):
    title: str
    logline: str
    theme: str
    core_conflict: str
    # 全书体量规划（作者执行专用；材料未给出可省略）
    total_word_count: Optional[str] = None
    total_chapters: Optional[str] = None
    chapter_word_count: Optional[str] = None
    world_rules: list[WorldRule] = []
    character_arcs: list[CharacterArc] = []
    volumes: list[Volume] = []
    foreshadowing_plan: list[ForeshadowingPlan] = []
    # 长线支线/长效副线：贯穿多卷、用于撑起长篇体量的持续剧情线
    subplots: list[str] = []
    # 通用保留区：文档/材料中出现、无法归入既有字段的重要信息
    # （风格取向、对标作品、创作参考、特殊约束、时间线规则等，无论叫什么名字）
    # 一律逐条原文收录，保证任何结构的输入都不丢失重要内容
    notes: list[str] = []
    # 导入模式专用：文档 vs 设定库的不一致记录；设定库为空或无冲突时为空数组
    blueprint_conflicts: list[BlueprintConflict] = []


# ---------- 核对师（导入文档 vs 生成蓝图，找遗漏） ----------


class BlueprintCheckItem(BaseModel):
    """单章节的比对结果。"""
    section: str  # 文档章节名（如 "1. 核心定位、风格与创作参考"）
    coverage: str = Field(..., pattern="^(full|partial|missing)$")  # full=完整收录 | partial=部分收录 | missing=未收录
    doc_excerpt: str = ""  # 文档该章节关键内容摘录（≤150 字，供人工核对）
    blueprint_field: str = ""  # 蓝图承接该内容的字段（notes/world_rules/character_arcs/volumes/subplots/total_*…；未知填"未收录"）
    note: str = ""  # 说明：缺了哪些点 / 只收录了一半

    @field_validator("coverage", mode="before")
    @classmethod
    def _norm_coverage(cls, v: object) -> object:
        """LLM 偶发输出 "Full"/"PARTIAL " 等变体，归一化后再做 pattern 校验。"""
        return str(v).strip().lower() if isinstance(v, str) else v


class BlueprintCheck(BaseModel):
    """核对师整体产出：逐节比对，missing 列出全部章节（含 full），由前端区分展示。"""
    total_sections: int
    missing: list[BlueprintCheckItem] = []


# ---------- 风格提取师（从导入文档提炼全局文风候选，供作者确认后写入 style_directive） ----------


class StyleExtraction(BaseModel):
    """从导入文档提炼出的"全局文风描述"候选（作者确认后作为 style_directive 使用）。"""
    style_directive: str


# ---------- 骨架校验师（导入大纲的骨架四件套语义校验，生成前体检） ----------


class OutlineSkeletonModule(BaseModel):
    """单个骨架模块的语义校验结果。

    id 覆盖六个通用大纲模块：四个必填骨架（scale/volumes/characters/plot）
    + 两个选填建议模块（pacing 爽点节奏 / differentiators 差异化卖点，模块通用、内容因书而异）。
    """
    id: str = Field(..., pattern="^(scale|volumes|characters|plot|pacing|differentiators)$")
    ok: bool
    # ok=true 时简述依据；ok=false 时说明缺什么 + 补全示例（供前端提示作者）
    reason: str
    # 是否为选填建议模块：必填四件套为 false，爽点/差异化 true（缺失不影响生成）
    optional: bool = False


class OutlineSkeletonCheck(BaseModel):
    """骨架校验师整体产出：判断导入大纲是否真实覆盖骨架模块（必填四件套 + 选填两项）。"""
    modules: list[OutlineSkeletonModule]


# ---------- 大纲师 ----------

CHAPTER_FUNCTIONS = [
    "progression", "buildup", "turning", "climax",
    "revelation", "resolution", "interlude",
]


class Beat(BaseModel):
    beat_no: int
    type: str = "scene"
    pov: str
    content: str
    length_hint: Optional[str] = None
    emotion: Optional[str] = None


class Conflict(BaseModel):
    type: str
    with_: str = Field(..., alias="with")
    stakes: str


class PlantItem(BaseModel):
    desc: str
    payoff_hint: str
    latest_payoff_chapter: Optional[int] = None
    # 关键信息固化（C）：跨多章、剧情关键、回收期远的伏笔标 high → 落库 is_pinned，账本超 20 条也不被挤出
    importance: str = "medium"


class ResolveItem(BaseModel):
    ledger_id: uuid.UUID
    how: str


class ThreadUpdate(BaseModel):
    thread: str
    new_state: str


class CharacterRef(BaseModel):
    """大纲登场角色：name 必填；position/note 可选。

    兼容两种输出形态：已有角色可只给名字（字符串），新登场角色须带定位说明
    （{name, position, note}），供大纲批准时沉淀为设定库角色卡。
    """
    name: str
    position: Optional[str] = None  # 定位：如「公司新同事」/「客户」
    note: Optional[str] = None  # 作用说明


class ChapterOutlineData(BaseModel):
    no: int
    title: str
    goal: str
    chapter_function: str = Field(..., pattern="^(progression|buildup|turning|climax|revelation|resolution|interlude)$")
    pov: str
    beats: list[Beat] = []
    characters: list[Union[str, CharacterRef]] = []  # 已有角色给名字；新登场角色带定位（批准时沉淀为设定）
    locations: list[str] = []
    conflicts: list[Conflict] = []
    plant_foreshadowing: list[PlantItem] = []
    resolve_foreshadowing: list[ResolveItem] = []
    thread_updates: list[ThreadUpdate] = []


class ChapterOutline(BaseModel):
    chapter: ChapterOutlineData


# ---------- 小说家 ----------


class NovelChapter(BaseModel):
    title: Optional[str] = Field(
        default=None,
        description="本章标题：大纲约束模式沿用大纲标题；自由草稿模式由 AI 拟定（简洁有力）",
    )
    content: str = Field(..., min_length=200, description="章节正文，长度下限防止空章/截断")
    note: str = Field(default="", description="自评：用到的设定、待回收伏笔等")


# ---------- 提取师 ----------


class KeyEvent(BaseModel):
    event: str
    importance: str = "medium"


class CharacterState(BaseModel):
    character: str
    state: str
    confidence: str = "high"


class WorldStateChange(BaseModel):
    rule: str
    change: str


class ForeshadowingItem(BaseModel):
    desc: str
    hint: Optional[str] = None
    suggested_payoff_chapter: Optional[int] = None


class ResolvedForeshadowing(BaseModel):
    ledger_id: uuid.UUID


class UnresolvedHook(BaseModel):
    hook: str
    since_chapter: Optional[int] = None


class RelationExtract(BaseModel):
    """提取师从章节文本抽出的实体关系（回填 entity_relations，dynamic 剧情层）。"""
    source: str
    relation: str
    target: str
    confidence: str = "high"


class SupersededRelation(BaseModel):
    """提取师识别出的被取代旧关系（自动标记失效，AI 注入跳过、展示灰显保留历史）。"""
    source: str
    relation: str
    target: str
    # 取代它的新关系名（必须是本章 relations 中同 source/target 的关系）。
    # 旧关系结束统一按「递进」处理（不再质疑 → 不质疑），递进时指名取代者可避免
    # 同一对实体本章有多条新关系（如 同事+不质疑 并存）时取代链指向错误的新关系；
    # 缺省时由后端按「同 source/target 的第一条新关系」兜底。
    superseded_by: Optional[str] = None


class StoryStateExtract(BaseModel):
    summary: str
    key_events: list[KeyEvent] = []
    character_states: list[CharacterState] = []
    world_state_changes: list[WorldStateChange] = []
    new_foreshadowing: list[ForeshadowingItem] = []
    resolved_foreshadowing: list[ResolvedForeshadowing] = []
    unresolved_hooks: list[UnresolvedHook] = []
    relations: list[RelationExtract] = []
    superseded_relations: list[SupersededRelation] = []  # 被取代的旧关系（如 师徒→叛出师门）
    next_chapter_implications: list[str] = []


# ---------- 编年师（作品编年总览） ----------


class ChronicleArc(BaseModel):
    """主线/副线进度条目。"""

    name: str  # 线名（如 主线/主角身世线/权谋线）
    status: str = Field(..., pattern="^(推进中|已完结|搁置)$")
    progress: str  # 已写到哪、下一关键节点是什么


class ChronicleCharacterGoal(BaseModel):
    character: str
    goal: str  # 当前目标
    progress: str  # 推进到哪一步


class ChronicleForeshadowing(BaseModel):
    desc: str  # 伏笔内容
    since_chapter: int  # 埋设章
    hint: str = ""  # 回收提示


class ChronicleOutput(BaseModel):
    """作品编年总览（每 N 章生成一次，token 固定，长期注入各 agent）。"""

    main_line: str  # 主线一句话：故事当前讲到哪
    volumes_progress: list[ChronicleArc] = []  # 各卷/各线进度
    character_goals: list[ChronicleCharacterGoal] = []  # 主要角色当前目标
    active_foreshadowing: list[ChronicleForeshadowing] = []  # 尚未回收的重要伏笔（含早期的）
    established_world: list[str] = []  # 已确立的重大设定/世界状态（长期有效，窗口外不丢）
    open_threads: list[str] = []  # 未解线索/遗留钩子
    next_direction: str = ""  # 后续自然走向


# ---------- 评价师 ----------


class RubricDimension(BaseModel):
    score: int = Field(..., ge=0, le=100)
    comment: str
    evidence: str = Field(..., min_length=1, description="强制原文引用，空视为无效输出")


class Rubric(BaseModel):
    blueprint_adherence: RubricDimension
    consistency: RubricDimension
    character_voice: RubricDimension
    pacing: RubricDimension
    style_compliance: RubricDimension
    foreshadowing_accountability: RubricDimension


class Issue(BaseModel):
    severity: str = Field(..., pattern="^(high|medium|low)$")
    type: str
    desc: str
    suggested_fix: Optional[str] = None
    ledger_ref: Optional[uuid.UUID] = None


class ReviewOutput(BaseModel):
    overall_score: int = Field(..., ge=0, le=100)
    rubric: Rubric
    issues: list[Issue] = []
    strengths: list[str] = []
    revision_hints: list[str] = []


# ---------- 通用运行请求 ----------


class AgentRunRequest(BaseModel):
    """SSE 通用入口 /api/stream/agents/{agent}/run 的请求体。"""

    novel_id: uuid.UUID
    params: dict = Field(default_factory=dict, description="角色相关参数（如章节目标、章节号等）")
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    version_count: Optional[int] = None
    dry_run: bool = Field(
        default=False,
        description="true=只生成不落库（调试沙箱），stored 事件返回产出供用户决定是否加入正式库",
    )


class AgentCommitRequest(BaseModel):
    """调试产物显式加入正式库：/api/stream/agents/{agent}/commit 的请求体。

    对应 dry_run 运行返回的 stored.data（单版本）或 versions[i].data（多版本）。
    """

    novel_id: uuid.UUID
    params: dict = Field(default_factory=dict)
    output: dict = Field(..., description="结构化产出（agent 各角色的输出协议）")
    source: Optional[str] = None
