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


class BlueprintIssue(BaseModel):
    """蓝图导入质检：导入文档「内部」的疑点（模糊没写清 / 前后矛盾）。

    与 BlueprintConflict（文档 vs 设定库）互补：这里只看文档自身，
    整理成蓝图前逐条交给作者确认怎么处理（按建议修正 / 保持原文 / 自定义）。
    """
    type: str = Field(..., pattern="^(vague|conflict|missing|quality|compliance)$")
    # vague=模糊不清 | conflict=前后矛盾 | missing=关键信息缺失 | quality=文档质量（乱码/内容过短） | compliance=内容合规预警
    item: str  # 疑点对象（角色名 / 时间 / 设定项 / 数字 / 机构名等）
    issue: str  # 问题描述（一句话说清哪里模糊 / 哪里矛盾）
    source: str = ""  # 文档原文摘录（≤80 字，必须出自原文；定位不到填「（无法定位原文）」）
    suggestion: str = ""  # 建议如何处理（一句话，可执行）
    # 可选：本条疑点要展示的处理选项 id（apply 按建议处理 / keep 保持原文 / delegate 交由蓝图师自行把握）。
    # 缺省给全三个；给出时按此清单展示（作者侧还会固定附一个「自定义输入」框）。
    options: list[str] = []


class BlueprintPrecheck(BaseModel):
    """蓝图质检师产出：疑点清单；没问题时 issues 为空数组。"""
    issues: list[BlueprintIssue] = []


class TimelineEvent(BaseModel):
    """时间线硬事实：把「2000年开始打工、2010年自主创业」这类散文变成可核对的数据。

    解决「机构/人物只有一句散文描述」的问题：蓝图里凡是带明确时间的事实
    （成立/入职/离职/创业/搬迁/重大事件/关系变化）逐条收录，写作/评价时
    作为确定性核对依据（entity_checker），不再靠 LLM 通读散文记忆。
    """
    # 时间区间与具体年份二选一：跨区间的用 period（如 "2000年—2010年"），
    # 有明确单年用 year；两者都没有的模糊时间不收录
    period: Optional[str] = None
    year: Optional[int] = None
    # 涉及实体（人物/机构/地点），同一实体的多个时间事实各自成条
    entity: str
    event: str
    # established=确立（该时间段内此状态成立）| changed=演变（状态发生改变）| ended=终结
    status: str = "established"


class OpeningAnchor(BaseModel):
    """开篇锚点（蓝图级硬决策）：第 1 章落在哪个时间切片、金手指/系统第几章揭示。

    把「第 1 章就亮系统 / 慢热铺垫」这类节奏决策从各角色各自解读，升级为蓝图级
    确定性声明——大纲师/章节规划师/小说家一律以此为据，作者在蓝图阶段已拍板。
    """
    # 第 1 章的时间切片（如写实事业流"入职第一天"；无明确锚点留空）
    first_chapter_slice: str = ""
    # 金手指/系统首次揭示的章节号（无金手指填 0）
    golden_finger_reveal_chapter: int = 0


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
    # 时间线硬事实：带明确时间的事实逐条收录（成立/入职/离职/创业/搬迁/重大事件），
    # 写作/评价时作为确定性核对依据（entity_checker），防止散文时间线被各角色各自解读
    timeline: list[TimelineEvent] = []
    # 开篇锚点：第 1 章时间切片 + 金手指揭示章（蓝图级硬决策，下游一律以此为据）
    opening_anchor: Optional[OpeningAnchor] = None
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


# ---------- 时代行业研究员（运行时按需生成"年代×行业"背景知识包） ----------


class EraResearch(BaseModel):
    """时代行业研究：LLM 按本小说的「年代×行业」现场研究，落库到 novel.era_research。

    解决"机构/老板/业务是否符合当时情况"——研究结果作为设定生成与评价的时代常识来源，
    换一本小说自动重新研究，不依赖开发期内置知识包。作者可在项目设置页查看/修改。
    """
    # 时代定位标签：以开局年份为起点的人类可读描述（如 "2000 年代起的现代都市"）。
    # **不是时间范围**——故事从 story_start_year 起按时间线向前推进，可能远超标签覆盖的
    # 年份（续写十年、二十年以上也成立），具体时代形态以 evolution 时间轴与带时间前提的
    # 红线为准。纯架空/无法判断时可为 "" 并写 note 说明
    era: str = ""
    # 故事开局年份：剧情起点的明确年份（如 2000）。研究员从素材推断；推断不出则为 None，
    # 生成蓝图前的研究确认弹窗会请作者直接填写——开局年份确定一次后，剧情按时间线推进，
    # 后续按"当前写到哪一年"对照对应年份的时代知识（红线按时间演进，见 era_mismatch_red_flags）
    story_start_year: Optional[int] = None
    # 判定行业（如 "人才中介/职业介绍"）
    industry: str = ""
    # 机构典型形态（门面/团队/招牌/登记册……按该年代行业的真实样子）
    organization_forms: list[str] = []
    # 老板/负责人画像（年龄段、出身、性格、提防什么……）
    boss_portrait: str = ""
    # 业务清单（该年代行业的真实业务范围）
    business_list: list[str] = []
    # 位置/布局规律（门店开在哪、为什么）
    location_pattern: str = ""
    # 行业阶段演进时间轴（从开局年份起，按年份排列，覆盖剧情可能写到的未来年份，
    # 不设 20 年上限——续写超越开局年代多年时，各年份形态按此轴演进，可用于分段剧情）
    evolution: list[str] = []
    # 时代错位雷点：该年代×行业最常见的"写作红线"（如 2000 年用线上 APP）。
    # **按时间演进表述**：每条红线必须带时间前提（如「2013 年前无微信」「2010 年后
    # 手机可上网」），而不是"全篇禁绝"——故事从开局年份向后跨越多年时，开局年代
    # 不该有的东西在其出现的年份之后是**应该有的**（2015 年主角用微信是正常设定）
    era_mismatch_red_flags: list[str] = []
    # 判定置信度：high / medium / low（依据越充分越高）
    confidence: str = "medium"
    # 判定依据：从项目前提/设定/导入文档的哪里判断出年代与行业（供作者核对）
    note: str = ""
    # 背景类型×题材校验：对照 novel.background_type / genres 与研究结论，指出错选/漏选/冲突。
    # 每项 {dim, current, suggested, issue, fix}：dim=background_type|genres；
    #   current=当前值；suggested=建议值；issue=问题描述；fix=改法。
    # 供蓝图生成前弹窗提示作者确认是否更新（作者定夺，不自动改）。
    scope_issues: list[dict] = []


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


class EntityDetailUpdate(BaseModel):
    """提取师识别出的实体细节（「首次提及即冻结」回写设定卡）。

    正文第一次把某个实体的事实写死（如"这公司1998年就成立了""全公司一共3个人"）
    时，提取师把它回写进设定库该实体的 structured.hard_facts / locked_details：
    - 已存在的硬事实不被覆盖（冻结语义：后来者不得推翻最早确立的说法）；
    - 之后写到的章节会被 entity_checker 用冻结值做确定性核对，矛盾即告警。
    """
    entity: str  # 实体名（须命中设定库/蓝图中已有的实体，或本章新确立的机构/地点）
    facts: dict = {}  # 可核对的键值事实，如 {"成立时间": "1998年", "人员规模": "3人"}
    source: str = ""  # 原文摘录（证据，尽量短）
    confidence: str = "high"


class NewCharacter(BaseModel):
    """提取师从正文识别出的新登场人物（设定库里没有）→ 沉淀为 character 设定卡。

    只记录「值得长期沿用」的人物：有身份/来历/性格/剧情作用，后续章节需要保持一致；
    一句话带过、无长期戏份的龙套不建卡。背景信息进设定卡作为「一致性依据」，
    正文不需要把全套背景写出来（正文只写当下情节需要的部分）。
    """
    name: str  # 人物名（须与正文一致；设定库已有名单里的人不算新人物，不建卡）
    aliases: list[str] = []  # 别名/称呼（正文里叫他的其他名字）
    role_rank: str = "minor"  # major（重要配角）/ minor（次要配角）/ extra（龙套但有戏份）
    description: str = ""  # 一段完整、可直接作为该人物设定描述的话（身份/来历/当前处境）
    personality: list[str] = []  # 性格特征（正文明确体现的才写，不脑补）
    appearance: str = ""  # 外貌（正文写过才写，没写留空）
    role_in_story: str = ""  # 在本章及后续的故事作用
    relations_to_main: str = ""  # 与主角/已有角色的关系（正文明确提到的）
    source_quote: str = ""  # 正文原文摘录（证据，尽量短）


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
    # 实体细节回写（首次提及即冻结）：正文确立的实体硬事实回写设定卡
    entity_detail_updates: list[EntityDetailUpdate] = []
    # 新登场人物（设定库没有、值得长期沿用）：沉淀为 character 设定卡
    new_characters: list[NewCharacter] = []
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


# ---------- 大纲方向提案师（生成大纲前咨询作者下一步发展脉络） ----------


class DirectionOption(BaseModel):
    """一个可选的发展脉络方向提案。"""

    id: str  # 稳定短 id（如 "a" / "b" / "c"），作者选择时回传
    label: str  # 方向名（如 "正面推进主线"）
    desc: str  # 一句话说明这个方向会怎么走（为什么这样走、会引出什么）


class DirectionProposal(BaseModel):
    """方向提案师产出：给作者的「下一步发展脉络」候选（3 个方向）。"""

    directions: list[DirectionOption] = Field(..., min_length=3, max_length=3)


# ---------- 章节规划师（写正文前咨询作者「本章规划」，合并大纲环节） ----------


class ChapterPlanDimensionOption(BaseModel):
    """单个候选选项：展示文本 + 该选项携带的结构化取值。

    作者在当前维度选其一（或自定义输入），取值并入执行方案；比"整体打包几套方案"更细：
    作者可对任意维度单独换选，不必整套推翻。""" 

    id: str  # 稳定短 id（如 "goal_1"），作者选中时回传
    text: str  # 候选文本（前端展示；作者选中后作为该维度取值）
    # —— 该选项携带的结构化信息（作者选中后合并进执行方案）——
    chapter_function: Optional[str] = None  # pace 维度：本章节奏功能（progression/climax/…）
    beats: Optional[list[str]] = None  # beats 维度：该套节拍序列（3-4 个，每个一句话）
    time_slice: Optional[str] = None  # goal 维度：该选项所处的时间切片（如「入职第一天」）


class ChapterPlanDimension(BaseModel):
    """一个可独立选择的维度：恰好 5 个候选选项，作者选其一或自定义输入。"""

    key: str  # goal/pov/beats/ending_hook/entry/tone/protagonist_arc/core_conflict/satisfaction
    label: str  # 维度名（如 "本章目标/节奏"、"视角"）
    hint: str = ""  # 一句话说明该维度要定什么
    options: list[ChapterPlanDimensionOption] = Field(..., min_length=5, max_length=5)


class ChapterPlanDimensionProposal(BaseModel):
    """章节规划师单次输出：只产出一个维度的候选选项。

    逐维度流式生成：每次只让作者面对一个维度（5 个固定不重复选项 + 1 个自定义输入），
    作者选定/输入后，规划师带着前面已定维度再生成下一个维度——而非一次性预生成全部。
    """

    dimension: ChapterPlanDimension


# ---------- 场景规划师（10 维度定稿后，把本章拆成 3-5 个场景逐字段确认） ----------


class SceneFieldChoices(BaseModel):
    """场景卡片中的一个字段：恰好 5 个候选选项（+ 前端 1 个自定义输入）。

    一个场景 = 五个字段（地点/出场人物/目标/冲突/结果），作者在卡片内逐字段单选或自定义，
    全部字段确认后拼进「场景执行清单」注入小说家作为硬约束。"""

    field: str  # location | participants | goal | conflict | outcome
    label: str  # 字段中文名（地点 / 出场人物 / 目标 / 冲突 / 结果）
    hint: str = ""  # 一句话说明该字段要定什么
    options: list[ChapterPlanDimensionOption] = Field(..., min_length=5, max_length=5)


class SceneCandidateProposal(BaseModel):
    """场景规划师产出的一个场景：五字段的候选选项（每字段恰好 5 个）。"""

    scene_index: int  # 第几个场景（1 起）
    fields: list[SceneFieldChoices] = Field(..., min_length=5, max_length=5)


class ScenePlanProposal(BaseModel):
    """场景规划师（plan 模式）单次输出：本章 3-5 个场景的骨架候选。

    基于作者已确认的 10 个维度（核心事件/节奏开场/视角/节拍/结尾钩子/进入触发/基调/主角弧/核心冲突/爽点），
    把这一章拆成 3-5 个可演的场景，每个场景五字段都给 5 个固定不重复候选。"""

    scenes: list[SceneCandidateProposal] = Field(..., min_length=3, max_length=5)


class SceneProposalsProposal(BaseModel):
    """场景规划师（proposal 模式）单次输出：某个场景的 5 个写法提案。

    每个提案约 100 字梗概，讲清该场景"怎么演"（起→冲突→收）；作者六选一（5 提案 + 自定义），
    选定后由小说家按该提案扩写成正文。"""

    scene_index: int
    proposals: list[ChapterPlanDimensionOption] = Field(..., min_length=5, max_length=5)


# ---------- 作者确认机制（生成流程内暂停点） ----------


class AuthorConfirmSubmitRequest(BaseModel):
    """提交作者确认答案：POST /api/stream/agents/confirm 的请求体。

    生成任务在确认点暂停等待，作者弹窗选择 AI 提案选项或输入自定义方向后提交，
    后台任务轮询到 answered 后读取答案继续生成。
    """

    confirm_id: uuid.UUID
    # 命中选项时存选项 id；自定义输入时存作者原文；"都不满意，重新生成"传 __regenerate__；
    # 场景卡片确认传 __fields__（具体取值在 field_answers 里）
    answer: str = Field(..., min_length=1, description="选项 id / 作者自定义文本 / __regenerate__ / __fields__")
    # 作者补充说明（可选，如"往第 3 个方向走，但要更轻松一些"）
    note: Optional[str] = None
    # 场景卡片确认：字段（location/participants/goal/conflict/outcome）→ 作者选定文本（选项 text 或自定义原文）
    field_answers: Optional[dict[str, str]] = None
