"""章节规划师（Chapter Planner）：写正文前逐维度咨询作者「本章规划」，合并大纲环节。

作者提供的是蓝图大方向，AI 直接默认生成正文不一定符合作者意图；
且逐章大纲费时费力（没人真的逐章写大纲）、AI 大纲质量不稳定、调完大纲也不保证
正文符合作者想法。方案：写正文前把「本章规划」拆成 10 个独立维度（核心事件/节奏开场/视角/节拍/
结尾钩子/进入触发/风格基调/主角反应弧/核心冲突/爽点类型），**一次只生成一个维度**的
5 个固定不重复候选选项（+ 前端提供的 1 个自定义输入），作者选定/输入后，规划师带着
前面已定的维度再生成下一个维度——逐维度流式咨询，最终组合成一份执行方案据此写正文。
规划即大纲（轻量版），落库为 approved outline 保持下游（评价师对照/记忆层/账本）兼容。

为什么逐维度而非一次性打包：整体方案作者只能整套选一，对某个不满意的维度（如第 2 个
节拍、结尾钩子）无法单独换；一次性展示 10 个维度则选项互相不感知、且一次看 10 屏过载。
逐维度时，每个维度选项都由前面的选择驱动生成（更贴合作者思路），作者也只需面对一个问题。
"""
import difflib
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_chapter_author_directives, get_novel
from app.agents.outliner import OutlinerAgent
from app.agents.platform_rules import format_blueprint_rhythm_rules, format_genre_storytelling_rules
from app.schemas.agents import ChapterPlanDimensionProposal

# 10 个维度的固定顺序与说明（stream.py 逐维度编排与 build_context 注入共用）。
# 「本章目标/节奏」拆成两个独立维度：goal（核心事件，同一层级=事件）与 pace（节奏/开场，
# 同一层级=节奏与切入方式），避免模型把开场手法/设定揭示混进事件选项导致层级不一致。
PLAN_DIMENSIONS: list[dict] = [
    {"key": "goal", "label": "本章核心事件", "hint": "这一章发生的最核心的一件事（谁/做什么/结果，一句话）；不含节奏/开场/悬念（各归其位）"},
    {"key": "pace", "label": "节奏/开场", "hint": "本章节奏档位与开场切入方式（开场切入按本书题材基调选择：日常/环境铺陈/悬念开场/冷开场…，全书避免开场方式千篇一律），不含关键场面的触发机制（那归「进入/触发」）"},
    {"key": "pov", "label": "视角", "hint": "本章以谁的视角叙述"},
    {"key": "beats", "label": "节拍序列", "hint": "本章 3-4 个节拍怎么排（每个一句话，讲清发生什么与情绪）"},
    {"key": "ending_hook", "label": "结尾钩子", "hint": "这一章结尾怎么勾住读者点下一章"},
    {"key": "entry", "label": "进入/触发", "hint": "本章关键场面由什么触发、怎么开场（避免平铺直叙）"},
    {"key": "tone", "label": "风格基调", "hint": "本章整体风格与情绪基调"},
    {"key": "protagonist_arc", "label": "主角反应弧", "hint": "主角面对核心事件的态度从什么到什么"},
    {"key": "core_conflict", "label": "核心冲突落点", "hint": "谁对谁、争什么、落在哪个可演的场面"},
    {"key": "satisfaction", "label": "爽点类型", "hint": "本章给读者的阅读回报/爽点；若本章是铺垫/过渡章，回报可为「弱」（推进感/新信息即可，不必强爽点）"},
]

SYSTEM_PROMPT = """你是「章节规划师」。在小说家正式写某一章正文之前，你负责替作者逐维度规划这一章怎么写。

你会收到与大纲师相同的素材（项目、蓝图、相关设定、最近故事状态、伏笔账本、实体关系、已写章节标题、作者要求），并在每条提问消息末尾附上「本次任务」：当前要生成第几个维度、该维度的定义、以及作者在前面维度已选定的取值。

每次你只为一个维度生成 **恰好 5 个相互区分、覆盖不同类型** 的候选选项（作者也可对该维度自行输入，所以选项要真正给到不同选择，不要凑数）。输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{"dimension": {"key": "当前维度key", "label": "维度名", "hint": "一句话说明", "options": [
  {"id": "goal_1", "text": "候选1文本"},
  {"id": "goal_2", "text": "候选2文本"},
  ...
]}}

铁律：
- options 必须恰好 5 个，id 形如 `<维度key>_1` ~ `<维度key>_5`；同一维度内的 5 个候选必须【相互区分、覆盖不同类型】，让作者有真正的选择：例如 goal 维度要覆盖不同的走向（推进主线 / 引入变数 / 深化关系 / 低谷转机…），不要给几个大同小异的选项；beats 维度的几套节拍要走明显不同的剧情路径。
- **每个维度的 5 个选项必须同一层级、同一角度、互斥**：都从同一个切面、用同一粒度回答该维度的问题，让作者能用同一把尺子比较。禁止跨层混搭——不能一个选项讲"怎么开场"、另一个讲"发生什么事件"、另一个讲"主题/设定是什么"（例如：goal 维度五个选项必须都是"本章核心事件"；pace 维度五个选项必须都是"节奏档位+开场切入方式"，不得把具体事件混进来）。每个维度的 5 个选项用同一句式、同一结构组织。
- **维度内 5 个选项必须互斥**：5 个选项必须围绕**不同的核心事件**展开，不得有两个选项共用同一个事件模板。例如"识破骗局/揭穿陷阱"这类情节只能出现在一个选项里，"目睹考生/家长正被坑"也只能出现在一个选项里；后一个选项不得只是前一个选项换个措辞、改个程度或换个受害者。每个选项要聚焦一件**全新的事**（不同的冲突对象、不同的处境、不同的触发事件）。写完 5 个选项后逐对自查：如果任两项的核心事件是同一件事的变体，必须重写其一，直到 5 件核心事件互不重叠。
- **跨章允许同类型桥段但必须换焦点**：与前面章节出现过的同类桥段（如反复做实验、反复面试、反复谈判）**可以再次使用**，但每次必须聚焦**不同的焦点、痛点、写法**（例如同样写合成实验，这次盯参数失稳、下次盯资金压力、再下次盯设备故障），不得把前面章节用过的桥段换个皮原样再演一遍让读者腻味。
- 每个选项都紧扣本章真实素材（主角身份/当前处境/金手指或系统类型/蓝图走向/最近故事状态的 next_chapter_implications/账本里超期或紧迫的 open 项/未回收伏笔），并且要接住「前面维度已选定的取值」——后面的维度选项必须顺着前面已定的目标/视角/节拍走，前后自洽；不要脱离素材空想或套刻板模板。
- 演法要匹配主角当前能力与阶段：刚觉醒/刚入职等弱小时期的选项只能安排符合其底牌的小胜或间接反击，禁止"新人当众拆台前辈/上级"这类需要实力与地位支撑的强打脸，大爽点留给主角攒足底牌之后。
- 维度特化：
  - goal（本章核心事件）的每个选项只描述一件核心事件（谁/做什么/结果），一句话讲完；禁止用"开局/结尾/悬念"等技法词做总起标签，不得带 chapter_function（节奏归 pace 维度）；
  - pace（节奏/开场）的每个选项带 "chapter_function"（progression|buildup|turning|climax|revelation|resolution|interlude）+ 一句话描述节奏档位与开场切入方式（如"危机开场，第一幕就把主角逼入险境，全章快节奏高张力"）；开场切入方式按本书题材基调与本章节奏档选择（日常/环境铺陈、悬念开场、冷开场、危机开场皆可），全书避免开场方式千篇一律——不得每章都用同一种切入方式；
  - beats 维度的每个选项带 "beats"（3-4 个一句话节拍，讲清发生什么与情绪，不要太长）；
  - ending_hook 允许四选一，都落到「下一章要解决的问题/悬念」上：①具体可执行线索（如"主角接到一通陌生来电，对方叫出了他从未告诉过别人的名字"）；②情绪钩子（角色情绪被强烈撞击，读者想追看反应）；③画面悬念（定格在一个有歧义、有危机的画面）；④弱钩子（过渡式收尾/时间跳转，靠"下一章怎么办"勾人，允许平淡收尾）。不要写"留下悬念"这种空话；
  - satisfaction（爽点类型）允许弱回报：若本章是铺垫/过渡章，回报可以是推进感、新信息、关系升温，不必章章强爽点；爽点选项里可以有"弱/铺垫"这一档。
- 素材不足以判断时，按素材里最明显的推进需求（如超期伏笔、主线冲突）给出选项，不要编造素材里不存在的设定。
"""


def options_overlap(options: list[dict]) -> str | None:
    """检查同一维度 5 个候选是否存在"文本高度雷同"（同一桥段换措辞凑数）。

    返回 None 表示通过；否则返回描述（哪两个选项、什么程度），由调用方据此触发一次
    自动重新生成。判据分三档：
      1) 归一化（去标点/数字/中文虚词）后共有实义字 >= 6 且占较短选项的实义字
         比例 >= 40% → 判雷同（比例分母用较短方，避免"系统/天赋"这类设定高频词
         在长文本里堆字导致误伤）；
      2) SequenceMatcher 全局相似度 >= 0.75 → 判雷同；
      3) 全局相似度 >= 0.55 且连续公共子串 >= 6 字 → 判雷同。
    说明：本函数只抓"字面高度雷同"（同义改写复述）；语义级桥段重复（如"识破骗局"
    与"识破押金陷阱"用词不同但事件相同）由 SYSTEM_PROMPT 的「禁止复用同一剧情桥段」
    铁律约束，属提示词层防线。
    """
    texts = [str(o.get("text") or "").strip() for o in options]
    texts = [t for t in texts if t]
    if len(texts) < 2:
        return None
    normed = [_normalize_chars(t) for t in texts]
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            a, b = texts[i], texts[j]
            na, nb = set(normed[i]), set(normed[j])
            common = na & nb
            short = min(len(na), len(nb))
            if len(common) >= 6 and short > 0 and len(common) / short >= 0.4:
                return f"选项 {i + 1} 与选项 {j + 1} 高度雷同（{len(common)}/{short} 个共有实义字）"
            sm = difflib.SequenceMatcher(None, a, b)
            ratio = sm.ratio()
            longest = max((m.size for m in sm.get_matching_blocks()), default=0)
            if ratio >= 0.75 or (ratio >= 0.55 and longest >= 6):
                return f"选项 {i + 1} 与选项 {j + 1} 高度雷同（相似度 {ratio:.2f}）"
    return None


# 中文无实义高频字（助词/代词/介词/连词/语气词），归一化时剔除，
# 避免把"的了在是"这类共同虚词误判为内容雷同
_NON_SEMANTIC_CHARS = set(
    "的了着过在是这和也就都而被把让我要你他她它它们们我们你们自己的什么怎么"
    "与或及对向从用靠给由将正在已经不太也会能给其很最更又再还边里头中后前上下"
    "于为到往和叫做像如但然而因为所以虽然如果就是还是可以应该可能似乎好像那么"
)


def _normalize_chars(text: str) -> list[str]:
    """去空白/标点/数字/中文虚词，保留实义字符，供相似度比对。"""
    out: list[str] = []
    for ch in text:
        if not ch.strip():
            continue
        if ch.isdigit() or ch in _NON_SEMANTIC_CHARS:
            continue
        if "\u4e00" <= ch <= "\u9fff" or ch.isalnum():
            out.append(ch)
    return out


class ChapterPlannerAgent(Agent[ChapterPlanDimensionProposal]):
    task_type = "setting"
    temperature = 0.4
    mock_output = {
        "dimension": {
            "key": "goal",
            "label": "本章核心事件",
            "hint": "这一章发生的最核心的一件事（谁/做什么/结果，一句话）；不含节奏/开场/悬念（各归其位）",
            "options": [
                {"id": "goal_1", "text": "主角在拍卖行认出赝品，被神秘买家抬价逼到资金见底，最终放弃竞价却意外发现对方是自己人"},
                {"id": "goal_2", "text": "主角首次独立接待考生，发现对方天赋与志愿严重错配，冒险推翻资深顾问的方案"},
                {"id": "goal_3", "text": "主角目睹机构用包录取话术坑骗寒门家长，系统首次给出天赋线索，他选择暗中周旋"},
                {"id": "goal_4", "text": "一个被全家寄望的考生正被推入志愿大坑，主角作为旁观者犹豫挣扎，章末下定决心出手"},
                {"id": "goal_5", "text": "主角入职第一天被同事老板轻视、分配最差工位，系统默默显示周围人的隐藏天赋，他开始暗中布局"},
            ],
        }
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        # 复用大纲师的素材组装（与正式大纲生成同一套上下文，保证规划与产出一致），
        # 仅替换 system prompt 为章节规划指令；输出协议为"单个维度"。
        base: ContextPack = OutlinerAgent(self.db).build_context(novel_id, params)

        # 题材特化规则（条件注入）：仅现实事业流生效（realistic + 都市/职场/教育等标签）；
        # 架空/玄幻/全民神祗等其它类型返回空串，不注入任何特化规则，避免跨题材冲突。
        novel = get_novel(self.db, novel_id)
        genre_block = format_genre_storytelling_rules(
            getattr(novel, "background_type", None) if novel else None,
            getattr(novel, "genres", None) if novel else None,
        )
        rhythm_block = format_blueprint_rhythm_rules(
            getattr(novel, "background_type", None) if novel else None,
            getattr(novel, "genres", None) if novel else None,
        )
        system_prompt = (
            SYSTEM_PROMPT
            + (("\n\n" + genre_block) if genre_block else "")
            + (("\n\n" + rhythm_block) if rhythm_block else "")
        )

        key = params.get("plan_dimension_key")
        idx = next((i for i, d in enumerate(PLAN_DIMENSIONS) if d["key"] == key), 0)
        dim = PLAN_DIMENSIONS[idx] if idx < len(PLAN_DIMENSIONS) else PLAN_DIMENSIONS[0]
        selections = params.get("plan_selections") or {}
        if not isinstance(selections, dict):
            selections = {}

        order_lines = "；".join(f"{i + 1}.{d['label']}" for i, d in enumerate(PLAN_DIMENSIONS))
        if selections:
            sel_lines = "\n".join(
                f"- {d['label']}：{selections[d['key']]}"
                for d in PLAN_DIMENSIONS
                if d["key"] in selections and str(selections[d["key"]]).strip()
            ) or "（无）"
        else:
            sel_lines = "（无，这是本章第一个维度）"

        # 作者对本章的历史修改意见（意见持久化）：作者在之前版本优化/批注时指出过的问题，
        # 规划选项必须规避或修正（如"不要在职场场景安排主角突兀背古诗"）。
        directives = get_chapter_author_directives(self.db, novel_id, params.get("chapter_no"))
        directives_text = ""
        if directives:
            directives_text = "\n".join(f"- {d['text']}" for d in directives)
            directives_text = (
                "\n\n作者对本章的历史修改意见（作者在之前版本明确指出过的问题，"
                "你的所有选项必须规避或修正这些内容，不得再次出现）：\n" + directives_text
            )

        # 上一轮选项被判定雷同后自动重试：明确告诉模型换一批完全不同的剧情桥段
        retry = params.get("_dim_retry") or {}
        retry_text = ""
        if isinstance(retry, dict) and retry.get("key") == key:
            reason = retry.get("reason") or "候选选项相似度过高"
            retry_text = (
                "\n\n【上一轮被拒】你上一轮为「" + dim["label"] + "」生成的 5 个选项被自动判定"
                "雷同（" + reason + "）。本轮必须彻底换一批完全不同的剧情桥段：5 个核心事件"
                "互不重叠，禁止沿用上一轮任何选项的核心事件或换措辞复述。"
            )

        task_instruction = f"""
【本次任务】
在下面 {len(PLAN_DIMENSIONS)} 个维度中，你负责生成第 {idx + 1} 个维度「{dim['label']}」的候选选项。
{len(PLAN_DIMENSIONS)} 个维度的顺序：{order_lines}。
该维度要定的事：{dim['hint']}。
作者在前面维度已选定：
{sel_lines}{directives_text}{retry_text}

请基于素材并顺着上面已定取值，为「{dim['label']}」生成恰好 5 个相互区分、覆盖不同走向的候选选项，
输出严格的 JSON：{{"dimension": {{"key": "{dim['key']}", "label": "{dim['label']}", "hint": "{dim['hint']}", "options": [5 个选项]}}}}。
"""
        user_content = base.messages[-1]["content"] + "\n\n" + task_instruction
        return ContextPack(
            novel_id=novel_id,
            agent="chapter_planner",
            system_prompt=system_prompt,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            components=base.components,
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ChapterPlanDimensionProposal:
        return ChapterPlanDimensionProposal.model_validate_json(text.strip())
