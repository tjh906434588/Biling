"""章节规划师（Chapter Planner）：写正文前逐维度咨询作者「本章规划」，合并大纲环节。

作者提供的是蓝图大方向，AI 直接默认生成正文不一定符合作者意图；
且逐章大纲费时费力（没人真的逐章写大纲）、AI 大纲质量不稳定、调完大纲也不保证
正文符合作者想法。方案：写正文前把「本章规划」拆成 3 个维度（核心事件/叙事方案/执行收尾），**一次只生成一个维度**的
3 个固定不重复候选选项（+ 前端提供的 1 个自定义输入），作者选定/输入后，规划师带着
前面已定的维度再生成下一个维度——逐维度流式咨询，最终组合成一份执行方案据此写正文。
规划即大纲（轻量版），落库为 approved outline 保持下游（评价师对照/记忆层/账本）兼容。

为什么逐维度而非一次性打包：整体方案作者只能整套选一，对某个不满意的维度（如叙事方案里的
节奏、结尾钩子）无法单独换；一次性展示 3 个维度则选项互相不感知、且一次看 3 屏过载。
逐维度时，每个维度选项都由前面的选择驱动生成（更贴合作者思路），作者也只需面对一个问题。
"""
import difflib
import json
import re
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_chapter_author_directives, get_novel
from app.agents.outliner import OutlinerAgent
from app.agents.platform_rules import format_blueprint_rhythm_rules, format_genre_storytelling_rules
from app.schemas.agents import CHAPTER_FUNCTIONS, ChapterPlanDimensionProposal
from app.services.rhythm_service import is_valid_rhythm_tag

# 3 个维度的固定顺序与说明（stream.py 逐维度编排与 build_context 注入共用）。
# 由 10 维度简化为 3 维度：约束链从 10 环减到 3 环，每个维度的候选都是「结构化方案」
# （多要素字段填槽），模型越界/发明新事件的空间最小，作者也只需确认 3 次：
#   - goal（核心事件）：事件 + 冲突落点 + 主角反应弧（同一层级 = 事件）
#   - narrative（叙事方案）：节奏档位 + 开场切入 + 视角 + 风格基调 + 进入方式（同一层级 = 怎么讲）
#   - execution（执行收尾）：节拍 + 结尾钩子 + 爽点（同一层级 = 推进与收尾）
# 每个选项携带的结构化字段在作者选中后映射回执行方案（plan dict）的对应 key，
# 下游（大纲落库/评价师/记忆层/账本）读取的 key 结构保持不变。
PLAN_DIMENSIONS: list[dict] = [
    {
        "key": "goal",
        "label": "核心事件",
        "hint": "这一章发生的最核心的一件事（谁/做什么/结果，一句话）。事件要同时给出『冲突落点』与『主角反应弧』两个要素：冲突=谁对谁、争什么、落在哪个可演的场面；反应弧=主角态度从什么到什么。只写事件本身与主角反应；节奏/开场/视角/风格/进入归「叙事方案」，节拍/结尾钩子归「执行收尾」；若蓝图声明了系统/金手指且本章为开篇章，金手指登场/觉醒即本章核心事件。",
        "forbidden": [
            "节奏档位/开场切入/视角/风格基调/进入方式（归「叙事方案」维度）",
            "系统/金手指的触发、点名、激活、面板内容、天赋清单等设定揭示细节（归「叙事方案」的进入方式；goal 只写事件本身与主角反应）",
            "节拍怎么排（归「执行收尾」维度）",
            "结尾悬念（归「执行收尾」维度）",
        ],
    },
    {
        "key": "narrative",
        "label": "叙事方案",
        "hint": "本章怎么讲这个故事——每个候选是一套完整叙事方案，五个要素齐备：①节奏档位（慢/中/快、平缓/收紧/高张力）②开场切入（日常/环境铺陈/悬念开场/冷开场/危机开场，全书避免千篇一律）③视角（第一人称/第三人称限知/第三人称全知/多视角切换）④风格基调（克制写实/轻快/压抑/悬疑/冷峻/幽默）⑤进入方式（关键场面由谁/哪句话/哪个细节触发、主角怎么注意到）。核心事件已由【前序已定】锁定，3 个候选必须全部围绕那个已定事件，只变化五要素的组合，严禁另写任何新事件。",
        "forbidden": [
            "另写一个别的新事件（核心事件已由【前序已定】锁定，叙事方案只在其上选节奏/开场/视角/风格/进入，把已定事件换成另一个场景就是不合规）",
            "节拍序列与结尾钩子的具体内容（归「执行收尾」维度）",
            "爽点类型判断（归「执行收尾」维度）",
        ],
    },
    {
        "key": "execution",
        "label": "执行收尾",
        "hint": "这一章怎么推进、怎么收尾——每个候选携带四要素：①beats（3-4 个一句话节拍，讲清发生什么与情绪，按顺序推进）②结尾钩子（四选一：具体可执行线索/情绪钩子/画面悬念/弱钩子·过渡式收尾，落到『下一章要解决的问题』，不写『留下悬念』空话）③爽点类型（小胜/推进感/新信息/关系升温/解气/铺垫，过渡章可为弱回报）④节奏标签 rhythm_tag（五选一：爽点/冲突/过渡/钩子/高潮——本章在整个故事节奏里的情绪功能，由节拍收束、钩子强度与爽点类型综合判定，用于全书爽点密度统计；弱回报且无冲突的衔接章=过渡，以悬念/新信息为核心=钩子，情绪峰值=高潮）。核心事件与叙事方案已由【前序已定】锁定，节拍必须建立在那套方案上推进，严禁另写任何新事件。",
        "forbidden": [
            "另写一个别的新事件（核心事件与叙事方案已由【前序已定】锁定，执行收尾只在其上排节拍/钩子/爽点）",
            "节奏档位词与整体开场判断（归「叙事方案」维度）",
            "系统触发机制与面板细节展开（归「叙事方案」的进入方式）",
        ],
    },
]

SYSTEM_PROMPT = """你是「章节规划师」。在小说家正式写某一章正文之前，你负责替作者逐维度规划这一章怎么写。

你会收到与大纲师相同的素材（项目、蓝图、相关设定、最近故事状态、伏笔账本、实体关系、已写章节标题、作者要求），并在每条提问消息末尾附上「本次任务」：当前要生成第几个维度、该维度的定义、以及作者在前面维度已选定的取值。

每次你只为一个维度生成 **恰好 3 个相互区分、覆盖不同类型** 的候选选项（作者也可对该维度自行输入，所以选项要真正给到不同选择，不要凑数）。输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{"dimension": {"key": "当前维度key", "label": "维度名", "hint": "一句话说明", "options": [
  {"id": "goal_1", "text": "候选1文本"},
  {"id": "goal_2", "text": "候选2文本"},
  ...
]}}

按各维度特化规则，选项可携带额外的结构化字段（作者选中后映射回执行方案）：
- goal（核心事件）维度每个选项带 "time_slice"（时间切片）、"core_conflict"（冲突落点）、"protagonist_arc"（主角态度弧线）；
- narrative（叙事方案）维度每个选项带 "pace"（节奏档位+开场切入）、"chapter_function"（progression|buildup|turning|climax|revelation|resolution|interlude）、"pov"（视角）、"tone"（风格基调）、"entry"（进入方式）；
- execution（执行收尾）维度每个选项带 "beats"（3-4 个一句话节拍）、"ending_hook"（结尾钩子）、"satisfaction"（爽点类型）。

铁律：
- options 必须恰好 3 个，id 形如 `<维度key>_1` ~ `<维度key>_3`；同一维度内的 3 个候选必须【相互区分、覆盖不同类型】，让作者有真正的选择：例如 goal 维度要覆盖不同的走向（推进主线 / 引入变数 / 深化关系 / 低谷转机…），不要给几个大同小异的选项；beats 维度的几套节拍要走明显不同的剧情路径。
- **每个维度的 3 个选项必须同一层级、同一角度、互斥**：都从同一个切面、用同一粒度回答该维度的问题，让作者能用同一把尺子比较。禁止跨层混搭——不能一个选项讲"怎么开场"、另一个讲"发生什么事件"、另一个讲"主题/设定是什么"（例如：goal 维度三个选项必须都是"核心事件"；narrative 维度三个选项必须都是"节奏+开场+视角+风格+进入"的完整叙事方案，不得把具体事件混进来）。每个维度的 3 个选项用同一句式、同一结构组织。
- **维度内 3 个选项必须互斥，但"互斥"的含义取决于该维度是否已锁定核心事件**：
  - goal（核心事件）是"选事件"的维度：3 个选项必须围绕**不同的候选事件**展开，不得共用同一个事件模板（例如"识破骗局/揭穿陷阱"这类情节只能出现在一个选项里）；每个选项要聚焦一件**全新的事**（不同的冲突对象、不同的处境、不同的触发事件），写完逐对自查：如果任两项是同一件事的变体，必须重写其一，直到 3 件候选事件互不重叠。
  - **narrative（叙事方案）与 execution（执行收尾）的核心事件已被前序已定锁定**：3 个候选必须**全部建立在那个已定事件之上**，只在该维度的切面内变化（narrative：节奏档位/开场切入/视角/风格/进入怎么配；execution：节拍怎么排、结尾怎么勾、给什么回报），**严禁另起炉灶写一个别的新事件**——若某个候选整体读起来是"另一个事件/另一个场景"，即为越界，必须重写。写完逐对自查：如果某两个选项其实是"两个不同的事件"而非"同一事件的同切面不同方案"，必须重写其一。
- **3 个选项必须落在同一时间切片**：所有候选必须发生在同一个阶段/时间点（如都锚定"入职第一天"、或都锚定"转正之后"），禁止跨阶段混搭——不能一半选项在"入职前"、另一半在"入职当天"，也不能一个选项里前半段入职前、后半段入职当天。跨阶段的选项不是互斥而是"能不能都选"的关系，作者没法用同一把尺子比较；若前面章节已选定的取值已锁定本阶段，3 个选项必须都锚定在该阶段展开，只在该切片内变化。
- **3 个选项调性/爽感浓度必须一致**：候选之间的爽感档位（写实克制 / 轻爽 / 强爽）要相近，禁止一半写实克制、一半大爽文放一起诱导作者选出调性不符的开局；若蓝图为本阶段排定的是铺垫/成长节奏，全部候选都按该档位给"小胜/推进/新信息"的回报，不要夹带一个不合拍的强爽候选。
- **跨章允许同类型桥段但必须换焦点**：与前面章节出现过的同类桥段（如反复做实验、反复面试、反复谈判）**可以再次使用**，但每次必须聚焦**不同的焦点、痛点、写法**（例如同样写合成实验，这次盯参数失稳、下次盯资金压力、再下次盯设备故障），不得把前面章节用过的桥段换个皮原样再演一遍让读者腻味。
- 每个选项都紧扣本章真实素材（主角身份/当前处境/金手指或系统类型/蓝图走向/最近故事状态的 next_chapter_implications/账本里超期或紧迫的 open 项/未回收伏笔），并且要接住「前面维度已选定的取值」——后面的维度选项必须顺着前面已定的目标/视角/节拍走，前后自洽；不要脱离素材空想或套刻板模板。
- 演法要匹配主角当前能力与阶段：刚觉醒/刚入职等弱小时期的选项只能安排符合其底牌的小胜或间接反击，禁止"新人当众拆台前辈/上级"这类需要实力与地位支撑的强打脸，也禁止"当众拆穿陌生行家/陌生中介"后再靠对方赏识当场收编的借力打脸，以及"恰好被贵人看中、当场收编/提携"的天降贵人巧合——弱小时期的机会必须靠主角自己的真实行动与底牌争取，大爽点留给主角攒足底牌之后。
- 维度特化（三维度，每个候选都是一套结构化方案）：
  - goal（核心事件）的每个选项只描述一件核心事件（谁/做什么/结果），一句话讲完，并携带三个结构化字段："time_slice"（一句话标明该选项所处的时间切片，如"入职第一天"）、"core_conflict"（冲突双方+争的焦点+一个可演的场面）、"protagonist_arc"（主角态度从什么到什么）。**text 这句话本身就要织入冲突与反应弧**：同一句话里既出现冲突（谁对谁/争什么/哪句转折，如"却/拦/质问/拆穿/两难"），又出现主角的反应（态度变化或动作，如"忍不住/暗下决心/试探/盯着"）——不能 text 只写"事件+系统登场"、把冲突和反应孤零零塞进字段（那样作者看到的选项就是缺冲突缺反应弧的）。禁止用"开局/结尾/悬念"等技法词做总起标签，不得带 chapter_function（节奏归 narrative）；**蓝图 opening_anchor 若声明了第 1 章时间切片且本章就是第 1 章，3 个选项必须锚定该切片、time_slice 完全一致（后续章节按剧情推进自由切换切片，不受此约束）**；**蓝图 opening_anchor 若声明了金手指揭示章且 == 本章章号，"金手指登场/觉醒"就是本章核心事件本身**——3 个选项必须是锚定该事件、落在同一时间切片下的互斥变体（金手指首次显现的不同方式+主角当场的处境与反应），可以写"金手指首次现身+主角反应"；系统弹出的面板内容、天赋清单、操作细则等设定揭示细节归 narrative 的进入方式，goal 只写事件本身。**若本章不是金手指揭示章，goal 聚焦人物驱动的事件，系统在事件中的参与按 narrative 的进入方式安排，不得为凑"系统登场"而偏离核心事件**；
  - narrative（叙事方案）的每个选项 = 一套完整叙事方案，携带五个结构化字段："pace"（节奏档位+开场切入一句话，如"中速·收紧，悬念开场"）、"chapter_function"（progression|buildup|turning|climax|revelation|resolution|interlude）、"pov"（视角类型）、"tone"（风格基调词）、"entry"（进入方式：关键场面由谁/哪句话/哪个细节触发）。节奏档位用档位词（慢/中/快、平缓/收紧/高张力…），开场切入用切入手法词（日常切入/环境铺陈/悬念开场/冷开场/危机开场…），全书避免开场方式千篇一律——不得每章都用同一种切入方式。**narrative 禁止另写新事件（核心事件已由前序锁定），更禁止把已定事件换成"系统怎么激活"的另一个场景**——判断标准：去掉叙事方案后，作者仍知道"这一章发生了什么"（核心事件已定），只知道"怎么讲"——这才合格。**候选 text 与 entry 必须出现已定核心事件的场景/实体词（人物/地点/关键道具），逐项自查：如果某个候选整体读起来像"另一个事件/另一个场景"，必须重写。**narrative 选项一旦写成"某某场景/事件 + 系统被激活"即为不合格；**叙事配置要与已定事件的走向一致**：事件是温情和解/宽恕/重逢类的，就不配"黑暗/残酷/冷峻/压抑"的基调与惨烈张力；事件是决裂/对峙/惨烈冲突类的，就不配"温馨/甜蜜/轻松"的调性——同一事件的叙事方案应与事件本身同频；
  - execution（执行收尾）的每个选项携带四个结构化字段："beats"（3-4 个一句话节拍，讲清发生什么与情绪，不要太长）、"ending_hook"（四选一，落到「下一章要解决的问题/悬念」上：①具体可执行线索 ②情绪钩子 ③画面悬念 ④弱钩子/过渡式收尾，不写"留下悬念"空话）、"satisfaction"（爽点类型，允许弱回报：若本章是铺垫/过渡章，回报可以是推进感、新信息、关系升温，不必章章强爽点）、"rhythm_tag"（节奏标签，五选一：爽点/冲突/过渡/钩子/高潮——由节拍收束、钩子强度与爽点类型综合判定本章在整个故事节奏里的情绪功能，用于全书爽点密度统计；弱回报且无对抗冲突的衔接/铺垫章=过渡，以悬念/新信息为核心功能=钩子，情绪峰值=高潮）。execution 同样禁止另写新事件——节拍必须建立在已锁定的核心事件与叙事方案上推进，不能把节拍写成另一个事件的流程；**beats 必须出现已定核心事件的场景/实体词（同一人物/地点/关键道具在推进，而非凭空换了个场景）。**执行收尾与事件走向一致：温情和解类事件不得配惨败/崩溃/身败名裂式收尾与钩子。
- 素材不足以判断时，按素材里最明显的推进需求（如超期伏笔、主线冲突）给出选项，不要编造素材里不存在的设定。
"""


# goal 维度「同模板换场景」的桥段模板词典：每类一组行为/事件关键词。
# 语义级桥段检测用：两个候选若命中同一桥段类（每类 >=2 个关键词），说明它们共用
# 同一事件模板、只是换了冲突对象/场景词（字面重合度可能很低，抓不到）。
# 不收录「系统/金手指」类——系统是主角标配，任何桥段都可能带系统参与，收录必误伤。
_BRIDGE_LEXICON: dict[str, frozenset[str]] = {
    "识破骗局/陷阱": frozenset({
        "识破", "看穿", "拆穿", "揭穿", "戳穿", "骗局", "陷阱", "圈套", "把戏", "套路",
        "障眼法", "蒙骗", "诓", "讹", "诈", "押金", "霸王条款", "暗箱", "造假", "掺假",
    }),
    "当众打脸/立威": frozenset({
        "当众", "打脸", "立威", "震慑", "镇住", "驳斥", "下不来台", "颜面扫地", "压场",
        "顶撞", "甩脸", "反唇相讥", "拍桌",
    }),
    "贵人赏识/提携": frozenset({
        "赏识", "提携", "招揽", "收编", "引荐", "举荐", "破格", "青眼", "另眼相待",
        "收徒", "看重",
    }),
    "隐藏身份/扮猪吃虎": frozenset({
        "隐藏", "隐瞒", "藏拙", "扮猪", "装傻", "深藏不露", "低调", "真人不露相",
        "藏锋", "隐忍",
    }),
    "突发事故/危机": frozenset({
        "突发", "意外", "故障", "事故", "出岔子", "捅娄子", "爆炸", "失火", "出事",
        "坍塌", "泄漏", "翻车",
    }),
    "误会错位/背锅": frozenset({
        "误会", "误解", "错怪", "冤枉", "背锅", "栽赃", "阴差阳错", "错位", "冒名",
        "张冠李戴",
    }),
    "谈判博弈/赌约": frozenset({
        "谈判", "谈崩", "抬价", "压价", "讨价还价", "对赌", "赌约", "筹码", "协议",
        "谈条件", "竞价",
    }),
    "考核测试/比试": frozenset({
        "考核", "测试", "验收", "摸底", "试炼", "比试", "切磋", "挑战", "笔试",
        "面试", "复试",
    }),
}


def _template_lexicon_hit(text: str) -> set[str]:
    """识别文本命中的桥段模板类（同一类 >=2 个关键词才算命中）。

    返回命中类名集合；空集表示未命中任何桥段模板。用于 goal 维度
    「同模板换场景」检测：两个候选若命中同一桥段类，说明事件模板同一。
    """
    hits: set[str] = set()
    for cls, words in _BRIDGE_LEXICON.items():
        if sum(1 for w in words if w in text) >= 2:
            hits.add(cls)
    return hits


def _shared_skeleton(a: str, b: str) -> tuple[int, float]:
    """结构骨架共享量：pair 的连续公共子串（>=4 字）总长与占较短方比例。

    骨架 = 剔除「被换掉的场景/实体词」后剩下的句式主干（如"识破X→反手让对方
    吃哑巴亏"）。占比高说明两候选是同一句式模板换了场景词，此时字面 set 重合
    可能不达标（实体词不同），需单独检测。
    """
    sm = difflib.SequenceMatcher(None, a, b)
    shared = sum(m.size for m in sm.get_matching_blocks() if m.size >= 4)
    short = min(len(a), len(b))
    return shared, (shared / short if short else 0.0)


def _option_field_signature(key: str, o: dict) -> str:
    """候选的结构化字段签名：完全一致即视为凑数/照抄。

    narrative 的区分在 pace/pov/tone/entry/chapter_function，execution 在
    beats/ending_hook/satisfaction（text 骨架因提示词强制同一句式，天然相似，
    不能作雷同判据）。goal 维度返回空串（走完整的字面+模板检测）。
    """
    if key == "narrative":
        return "|".join(str(o.get(f) or "") for f in ("pace", "chapter_function", "pov", "tone", "entry"))
    if key == "execution":
        beats = "|".join(str(b or "") for b in (o.get("beats") or []))
        return "|".join([beats, str(o.get("ending_hook") or ""), str(o.get("satisfaction") or "")])
    return ""


def options_overlap(options: list[dict], key: str = "") -> str | None:
    """检查同一维度 3 个候选是否「相互区分」不足（凑数/雷同）。

    返回 None 表示通过；否则返回描述（哪两个选项、什么程度），由调用方据此触发
    自动重新生成。判据分两族：
    一、字面族（所有维度，抓「同义改写复述」）：
      1) 归一化（去标点/数字/中文虚词）后共有实义字 >= 6 且占较短选项实义字
         比例 >= 40% → 判雷同（比例分母用较短方，避免"系统/天赋"这类设定高频词
         在长文本里堆字导致误伤）；
      2) SequenceMatcher 全局相似度 >= 0.75 → 判雷同；
      3) 全局相似度 >= 0.55 且连续公共子串 >= 6 字 → 判雷同。
    二、模板族（仅 goal 维度，抓「同模板换场景」——字面重合不高但句式/桥段同一）：
      4) 结构骨架共享占比 >= 45% 且共享骨架 >= 8 字 → 判「同模板换场景」；
      5) 两候选命中同一桥段模板类（见 _BRIDGE_LEXICON）→ 判「同桥段换场景」。
    goal 维度额外并入 core_conflict/protagonist_arc 字段参与比对，模板重复更易暴露。
    narrative/execution 因 3 个候选本就锚定同一核心事件、text 天然共享设定词/实体词，
    字面族只保留「几乎照抄」（全局相似度 >= 0.75）这一档，跳过 set 重合档与短公共子串
    档，避免把合理的「同事件同切面变体」误判成雷同。
    """
    texts = [str(o.get("text") or "").strip() for o in options]
    texts = [t for t in texts if t]
    if len(texts) < 2:
        return None
    normed = [_normalize_chars(t) for t in texts]
    if key == "goal":
        for idx, o in enumerate(options):
            extra = "".join(str(o.get(f) or "") for f in ("core_conflict", "protagonist_arc"))
            if extra.strip():
                normed[idx] = normed[idx] + _normalize_chars(extra)
    full_norm = ["".join(n) for n in normed]
    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            a, b = texts[i], texts[j]
            sm = difflib.SequenceMatcher(None, a, b)
            ratio = sm.ratio()
            blocks = sm.get_matching_blocks()
            longest = max((m.size for m in blocks), default=0)
            if key != "goal":
                # narrative/execution：text 骨架天然相似（同事件同切面变体），
                # 只抓「整卡照抄」——text 完全一致或结构化字段签名完全一致
                if full_norm[i] == full_norm[j]:
                    return f"选项 {i + 1} 与选项 {j + 1} 完全相同"
                if _option_field_signature(key, options[i]) == _option_field_signature(key, options[j]):
                    return f"选项 {i + 1} 与选项 {j + 1} 结构化字段完全相同（凑数）"
                continue
            if ratio >= 0.75:
                return f"选项 {i + 1} 与选项 {j + 1} 高度雷同（相似度 {ratio:.2f}）"
            na, nb = set(normed[i]), set(normed[j])
            common = na & nb
            short = min(len(na), len(nb))
            if len(common) >= 6 and short > 0 and len(common) / short >= 0.4:
                return f"选项 {i + 1} 与选项 {j + 1} 高度雷同（{len(common)}/{short} 个共有实义字）"
            if ratio >= 0.55 and longest >= 6:
                return f"选项 {i + 1} 与选项 {j + 1} 高度雷同（相似度 {ratio:.2f}）"
            shared, sk = _shared_skeleton(full_norm[i], full_norm[j])
            if shared >= 8 and sk >= 0.45:
                return f"选项 {i + 1} 与选项 {j + 1} 疑似同模板换场景（结构骨架共享 {shared} 字，占比 {sk:.0%}）"
            common_tpl = _template_lexicon_hit(full_norm[i]) & _template_lexicon_hit(full_norm[j])
            if common_tpl:
                cls = sorted(common_tpl, key=len)[0]
                return f"选项 {i + 1} 与选项 {j + 1} 疑似同一桥段模板（{cls}），只是换了场景/对象"
    return None


# 触发机制/设定揭示关键词（识别模型把别的维度的内容混进当前维度）。
# 三维度下由 narrative 的「进入方式」要素承载系统/面板触发细节，goal 只写事件本身；
# 若 goal 候选整段写成"场景+系统激活"（偏离事件本体）可据此识别。
_TRIGGER_MECHANISM_PATTERNS = [
    re.compile(r"系统.{0,8}(激活|面板|天赋|推荐|空白|显示|弹出|窗口)"),
    re.compile(r"(被)?(激活|触发|点名|觉醒).{0,6}(系统|金手指)"),
    re.compile(r"金手指.{0,8}(激活|兑现|触发|展威|点亮)"),
    re.compile(r"(面板|天赋清单|适配推荐|推荐栏)"),
]
# 合法 chapter_function 取值集合（校验 narrative 候选的 chapter_function 字段是否在协议内）
_VALID_CHAPTER_FUNCTIONS = set(CHAPTER_FUNCTIONS)

# goal 维度「同一时间切片」校验：候选必须落在同一阶段/时间点（如都锚定"入职第一天"），
# 禁止跨阶段混搭（一半入职前/一半入职当天 → 选项不是互斥而是"能不能都选"的关系）。
# 阶段关键词按三组互斥分组：命中不同组、或单个选项命中多组 → 判跨切片，自动重试。
_TIME_SLICE_GROUPS = [
    {"招聘会", "投简历", "求职", "待业", "应届", "碰壁", "盘缠", "海投", "找工作"},
    {"第一天", "首日", "报到", "工位", "柜台", "上岗", "办理入职", "签合同"},
    {"转正", "升职", "跳槽", "创业", "自立门户", "独立负责", "带徒弟", "续约"},
]
_TIME_SLICE_GROUP_NAMES = ["入职前（求职/碰壁/待业期）", "入职当天（报到/首日）", "入行后（转正/升职/创业等）"]


def _time_slice_conflict(options: list[dict]) -> str | None:
    """检查 goal 维度候选是否落在同一时间切片（同一阶段/时间点）。

    优先用候选携带的结构化 time_slice 字段判定：所有选项必须都带该字段且值一致。
    值不一致时（如同一天的不同子时刻：上午/中午/下午…，字符串不同但属同一阶段），
    回退阶段关键词启发式判定——同属一个阶段组即视为同一切片，避免把「同一天不同
    时刻」误判成跨切片，导致模型反复自动重试、最终只能降级兜底（真实问题）。
    全部未声明时同样走关键词启发式（兼容模型未输出字段/旧逻辑）。
    """
    slices = [str(o.get("time_slice") or "").strip() for o in options]
    non_empty = [s for s in slices if s]
    if non_empty:
        if len(non_empty) != len(options):
            return "goal 维度存在选项未声明 time_slice（时间切片），所有选项必须都带该字段且一致"
        if len(set(non_empty)) == 1:
            return None
        # 结构化 time_slice 字符串不一致：回退阶段分组判定（同一阶段的不同子时刻仍算同一时间切片）
        return _time_slice_group_check(options)
    # 回退：候选未带 time_slice 字段时，用阶段关键词启发式判定（跨阶段混搭判不合规）
    return _time_slice_group_check(options)


def _time_slice_group_check(options: list[dict]) -> str | None:
    """阶段关键词启发式：候选是否横跨不同阶段组（入职前/入职当天/入行后）。

    返回 None 表示同一切片；否则返回原因。同一阶段内的不同子时刻（上午/中午/下午）
    不会被拆成多个组，因此视为同一切片。
    """
    hits: dict[int, int] = {}  # 选项下标 → 命中的组号
    for i, o in enumerate(options):
        text = str(o.get("text") or "")
        hit = [gi for gi, group in enumerate(_TIME_SLICE_GROUPS) if any(kw in text for kw in group)]
        if len(hit) > 1:
            return f"选项 {i + 1} 自身跨越了多个阶段（同时命中 {len(hit)} 组阶段词），单个选项必须落在同一时间切片"
        if len(hit) == 1:
            hits[i] = hit[0]
    if len(hits) >= 2 and len(set(hits.values())) > 1:
        names = " / ".join(sorted({_TIME_SLICE_GROUP_NAMES[g] for g in hits.values()}))
        return "候选横跨了不同时间切片（" + names + "），必须全部锚定同一阶段/时间点展开——互斥的前提是发生在同一时刻的多个可能"
    return None


# 金手指锚定（goal 维度，仅开篇章）：蓝图文本里声明了系统/金手指，但候选全都不含任何登场
# 信号 → 判不合规自动重试，防止模型把系统完全拿掉（真实 bug：goal 3 个候选全成纯职场文）。
_GOLDEN_FINGER_SIGNALS = ["系统", "金手指", "外挂", "面板", "天赋", "抽卡", "签到"]

# 弱小时期（开篇章）主角承受不了的强打脸/天降贵人巧合：机会必须靠自己的真实行动与底牌争取。
_WEAK_PHASE_OVERPOWER_PATTERNS = [
    re.compile(r"当众.{0,6}(拆穿|揭穿|戳穿|打脸|戳破)"),
    re.compile(r"(看中|看上|相中).{0,10}(当场|立刻|马上|当即|直接)(收|录用|聘请|入职)"),
    re.compile(r"(当场|立刻|马上|当即).{0,6}(收编|录用|收留|看中收)"),
    re.compile(r"(贵人|伯乐).{0,8}(相助|提携|看中|赏识)"),
]


def goal_extra_check(blueprint: dict | None, chapter_no: int, options: list[dict]) -> str | None:
    """goal 维度补充校验（需要蓝图上下文，由 stream.py 调用）：
      1) 金手指锚定：蓝图 opening_anchor 声明金手指揭示章 == 本章 → 判合规要求候选至少一个
         含金手指登场/觉醒（金手指登场即该章核心事件，模型不得把系统从选项里拿掉）；
         无结构化声明（旧蓝图）时回退文本信号，且仅开篇章按惯例锚定。
      2) 弱小时期强打脸/天降贵人拦截（仅开篇章）：禁止"当众拆穿行家后被当场收编"、
         恰好被贵人看中当场录用类借力打脸（与懵懂成长人设冲突，毁掉成长弧线）。
    """
    reveal = 0
    anchor = (blueprint or {}).get("opening_anchor") if isinstance(blueprint, dict) else None
    if isinstance(anchor, dict):
        try:
            reveal = int(anchor.get("golden_finger_reveal_chapter") or 0)
        except (TypeError, ValueError):
            reveal = 0
    if reveal >= 1:
        # 蓝图结构化声明为准：金手指揭示章 == 本章 → 金手指登场即核心事件（尊重慢热/悬疑安排）
        needs_gf = reveal == chapter_no
    else:
        # 无结构化声明（旧蓝图）：开篇章按惯例锚定（文本信号回退）
        bp_text = json.dumps(blueprint, ensure_ascii=False) if blueprint else ""
        needs_gf = chapter_no == 1 and bool(bp_text and any(sig in bp_text for sig in _GOLDEN_FINGER_SIGNALS))
    if needs_gf:
        texts = [str(o.get("text") or "") for o in options]
        if not any(any(sig in t for sig in _GOLDEN_FINGER_SIGNALS) for t in texts):
            return "蓝图声明本章揭示金手指" + (f"（第 {reveal} 章）" if reveal else "") + "，goal 的 3 个候选却全部不含金手指登场/觉醒——金手指登场即本章核心事件，至少一个候选必须锚定它"
    if chapter_no == 1:
        # 弱小时期（开篇章）强打脸/天降贵人拦截
        for o in options:
            text = str(o.get("text") or "")
            for pat in _WEAK_PHASE_OVERPOWER_PATTERNS:
                if pat.search(text):
                    return "goal 存在选项安排了弱小时期主角承受不了的强打脸/天降贵人巧合（命中模式：" + pat.pattern + "），机会必须靠主角自己的真实行动与底牌争取"
    return None


# narrative 维度「视角类型」声明标记（pov 字段）：必须明确给出视角类型。
# 一个 pov 字段如果通篇没有视角标记词，基本就是模型把「视角」写成了「换个角度复述核心事件」，
# 抢了 goal 维度的职责（真实问题：10 维度时代的 pov 候选全是「场景+系统激活+天赋浮现」的事件描述）。
_POV_MARKERS = ["第一人称", "第三人称", "人称", "全知", "限知", "上帝视角", "主视角", "视角"]

# pace 维度「节奏档位/开场切入」要素词，分两组：候选必须**各命中至少一个**（档位词 + 切入词），
# 否则说明没同时给出「节奏档位 + 开场切入方式」这两个要素，只是干巴巴描述事件/场景（抢了 goal 的活）。
_PACE_LEVEL_MARKERS = [
    "慢", "中", "快", "平缓", "收紧", "高张力", "舒缓", "紧张", "急促", "松弛",
]
_PACE_OPENING_MARKERS = [
    "悬念", "冷开场", "日常", "环境", "铺陈", "危机", "切入", "开场", "起笔", "入手",
]

# fix6「前序已定自相矛盾」检测词典：已定核心事件的走向，必须与叙事配置/执行收尾一致。
# 只对走向明确的 goal 生效（命中正向收束或负向冲突词典），日常/中性事件不触发。
_GOAL_WARM_RESOLUTION_MARKERS = [
    "和解", "释怀", "冰释", "和好", "道歉", "原谅", "宽恕", "感激", "感谢", "感动",
    "温情", "温暖", "治愈", "救赎", "重逢", "携手", "破涕为笑", "重归于好", "尽释前嫌",
    "拥抱", "交心", "谈心", "敞开心扉", "和好如初",
]
_GOAL_HARSH_CONFLICT_MARKERS = [
    "决裂", "反目", "撕破脸", "决斗", "血战", "搏杀", "生死", "惨败", "崩溃",
    "身败名裂", "羞辱", "当众出丑", "破产", "重伤", "丧命", "家破", "陷害", "栽赃",
    "兵戎相见", "你死我活",
]
# narrative 配置（tone+pace）与 goal 走向相反的证据词
_NARRATIVE_COLD_TONE_MARKERS = ["黑暗", "残酷", "冷峻", "压抑", "悲凉", "绝望", "灰暗", "惨淡", "冰冷", "肃杀", "沉重", "阴郁"]
_NARRATIVE_WARM_TONE_MARKERS = ["治愈", "温情", "温馨", "温暖", "甜蜜", "轻松", "明亮", "暖阳", "柔和"]
# execution 收尾（ending_hook+satisfaction+beats）与 goal 走向相反的证据词
_EXECUTION_DIRE_ENDING_MARKERS = ["惨败", "溃败", "崩溃", "身败名裂", "绝望", "彻底失败", "重伤", "丧命", "倾家荡产", "家破人亡", "满盘皆输"]


def _goal_resolution_direction(goal_text: str) -> str:
    """判定已定核心事件的走向：warm（正向收束）/ harsh（负向冲突）/ ""（中性，不检测）。"""
    warm = any(m in goal_text for m in _GOAL_WARM_RESOLUTION_MARKERS)
    harsh = any(m in goal_text for m in _GOAL_HARSH_CONFLICT_MARKERS)
    if warm and not harsh:
        return "warm"
    if harsh and not warm:
        return "harsh"
    return ""


def _narrative_mood_conflict(direction: str, o: dict) -> str | None:
    """narrative 候选的 tone+pace 是否与已定事件走向明显相反。"""
    mood = str(o.get("tone") or "") + str(o.get("pace") or "")
    if direction == "warm" and any(m in mood for m in _NARRATIVE_COLD_TONE_MARKERS):
        return f"叙事配置与已定事件的温情走向相反（tone/pace 含『{next(m for m in _NARRATIVE_COLD_TONE_MARKERS if m in mood)}』）"
    if direction == "harsh" and any(m in mood for m in _NARRATIVE_WARM_TONE_MARKERS):
        return f"叙事配置与已定事件的冲突走向相反（tone/pace 含『{next(m for m in _NARRATIVE_WARM_TONE_MARKERS if m in mood)}』）"
    return None


def _execution_mood_conflict(direction: str, o: dict) -> str | None:
    """execution 候选的收尾（钩子+爽点+节拍）是否与已定事件走向明显相反。"""
    if direction != "warm":
        return None
    tail = "".join([
        str(o.get("ending_hook") or ""),
        str(o.get("satisfaction") or ""),
        "".join(str(b or "") for b in (o.get("beats") or [])),
    ])
    hit = next((m for m in _EXECUTION_DIRE_ENDING_MARKERS if m in tail), None)
    if hit:
        return f"执行收尾与已定事件的温情走向相反（含『{hit}』）"
    return None


def dimension_compliance_check(key: str, options: list[dict], prev_goal: str = "") -> str | None:
    """校验某维度 3 个候选是否"同一层级、同一角度"（内容符合该维度定义）。

    与 options_overlap（查字面雷同）互补：这里查"跨层混搭"——把别的维度/别的层级的内容
    混进本维度。返回 None 通过，否则返回原因描述，由调用方据此触发一次自动重新生成。当前覆盖：
      - goal（核心事件）：3 个候选必须落在同一时间切片；每个选项必须带 core_conflict（冲突
        落点）与 protagonist_arc（主角反应弧）字段——候选必须是『事件+冲突+反应弧』的完整方案；
        且 text 与两个字段合并后要真含冲突与反应表达（冲突/反应可由 text 或字段任一承载）；
      - narrative（叙事方案）：每个选项必须五要素字段齐备（pace/chapter_function/pov/tone/
        entry），pace 字段必须同时含节奏档位词与开场切入词；且必须锚定【前序已定】核心事件
        （prev_goal 非空时，候选文本须命中已定事件的锚定 n-gram，禁止另写新事件/新场景）；
        事件走向明确时，tone/pace 配置不得与事件走向相反（温情事件配冷酷压抑/冲突事件配温馨）；
      - execution（执行收尾）：每个选项必须带 beats（3-4 个非空一句话节拍）+ ending_hook +
        satisfaction；且节拍必须建立在已定核心事件上推进（prev_goal 非空时同样校验锚定）；
        温情走向事件的收尾不得配惨败/崩溃类结局。
    """
    if key == "goal":
        for o in options:
            # 冲突与反应弧由 core_conflict / protagonist_arc 两字段承载（作者在卡片里与 text 并列看到），
            # 字段非空即认为该选项是『事件+冲突+反应弧』的完整方案。不再用字面关键词校验 text——
            # 关键词表覆盖不了自然中文的冲突/反应表达，合法候选只因措辞未命中字面词就会被反复判
            # 不合规、连重试 3 次后落入兜底（真实问题），删去字面校验、保留字段必填与同切片校验。
            if not str(o.get("core_conflict") or "").strip():
                return "goal 维度存在选项缺少 core_conflict（冲突落点：谁对谁、争什么、落在哪个可演的场面）——每个候选必须是『事件+冲突+反应弧』的完整结构化方案"
            if not str(o.get("protagonist_arc") or "").strip():
                return "goal 维度存在选项缺少 protagonist_arc（主角反应弧：态度从什么到什么）——每个候选必须是『事件+冲突+反应弧』的完整结构化方案"
        return _time_slice_conflict(options)
    if key == "narrative":
        direction = _goal_resolution_direction(prev_goal) if prev_goal else ""
        for o in options:
            if prev_goal and not _anchored_on_event(_option_full_text(key, o), prev_goal):
                return "narrative 维度存在选项未锚定【前序已定】的核心事件（候选文本不含已定事件的场景/实体词）——3 个候选必须全部建立在已定事件之上，只变化节奏/开场/视角/风格/进入，严禁另写一个新事件或把已定事件换成另一个场景"
            if direction and (conflict := _narrative_mood_conflict(direction, o)):
                return "narrative 维度存在选项与【前序已定】核心事件自相矛盾：" + conflict + "——同一事件的叙事方案应与事件本身走向一致，不能温情和解配冷酷压抑、冲突对峙配温馨轻快"
            pace_txt = str(o.get("pace") or "").strip()
            if not (
                any(m in pace_txt for m in _PACE_LEVEL_MARKERS)
                and any(m in pace_txt for m in _PACE_OPENING_MARKERS)
            ):
                return "narrative 维度存在选项的 pace 字段没有同时给出「节奏档位」与「开场切入」两个要素（需各含一个档位词如慢/中/快、平缓/收紧，和一个切入词如悬念开场/冷开场/日常切入）"
            if str(o.get("chapter_function") or "").strip() not in _VALID_CHAPTER_FUNCTIONS:
                return "narrative 维度存在选项缺少合法的 chapter_function"
            if not any(m in str(o.get("pov") or "") for m in _POV_MARKERS):
                return "narrative 维度存在选项的 pov 字段没有声明视角类型（第一人称/第三人称限知/全知等）"
            if not str(o.get("tone") or "").strip():
                return "narrative 维度存在选项缺少 tone（风格基调词）"
            if not str(o.get("entry") or "").strip():
                return "narrative 维度存在选项缺少 entry（进入方式：由谁/哪句话/哪个细节触发、主角怎么注意到）"
        return None
    if key == "execution":
        direction = _goal_resolution_direction(prev_goal) if prev_goal else ""
        for o in options:
            if prev_goal and not _anchored_on_event(_option_full_text(key, o), prev_goal):
                return "execution 维度存在选项未锚定【前序已定】的核心事件（节拍不含已定事件的场景/实体词）——节拍必须建立在已锁定核心事件上推进，不能把节拍写成另一个事件的流程"
            if direction and (conflict := _execution_mood_conflict(direction, o)):
                return "execution 维度存在选项与【前序已定】核心事件自相矛盾：" + conflict + "——执行收尾应与事件本身走向一致，不能温情和解配惨烈失败收尾"
            beats = o.get("beats")
            if not isinstance(beats, list) or not (3 <= len(beats) <= 4):
                return "execution 维度存在选项未带 beats 字段或节拍数量不在 3-4 个（只写了概述/情绪，没拆成按顺序推进的一句话节拍）"
            for b in beats:
                if not str(b or "").strip():
                    return "execution 维度存在选项的 beats 字段含空节拍，每个节拍必须是一句有内容的话"
            if not str(o.get("ending_hook") or "").strip():
                return "execution 维度存在选项缺少 ending_hook（结尾钩子：落到下一章要解决的问题/悬念）"
            if not str(o.get("satisfaction") or "").strip():
                return "execution 维度存在选项缺少 satisfaction（爽点类型）"
            if not is_valid_rhythm_tag(o.get("rhythm_tag")):
                return (
                    "execution 维度存在选项的 rhythm_tag 不是合法节奏标签（必须五选一："
                    + "爽点/冲突/过渡/钩子/高潮）——每个候选必须携带本章的节奏标签"
                )
        return None
    return None


# 各维度必填结构化字段的「降级兜底」占位（stream.py 连续 3 次生成仍不合规时，用最小占位
# 让选项字段齐备供作者参考）。兜底内容明确标注"系统兜底补全"，绝不静默推不合规候选。
_FALLBACK_FIELD_FILL: dict[str, dict] = {
    "goal": {
        "time_slice": "本章",
        "core_conflict": "围绕该事件所述场面展开的冲突（系统兜底补全，建议自定义）",
        "protagonist_arc": "主角对该事件的态度变化（系统兜底补全，建议自定义）",
    },
    "narrative": {
        "pace": "中速·收紧，日常切入（系统兜底补全）",
        "chapter_function": "progression",
        "pov": "第三人称限知",
        "tone": "克制写实",
        "entry": "由事件关键细节触发进入（系统兜底补全）",
    },
    "execution": {
        "beats": ["按已定核心事件推进的节拍（系统兜底补全，建议自定义）"],
        "ending_hook": "弱钩子·过渡式收尾（系统兜底补全）",
        "satisfaction": "推进感（系统兜底补全）",
        "rhythm_tag": "过渡（系统兜底补全）",
    },
}


def fallback_repair_options(key: str, options: list[dict], reasons: list[str]) -> list[dict]:
    """降级兜底：连续多次生成仍不合规时，对候选做字段补齐并打上兜底标记。

    只在缺失/不合法的结构化字段上填最小占位（标注"系统兜底补全"），不修改模型产出的
    text 正文，并把每个选项标记 fallback=True——调用方据此在前端/确认语中提示作者
    「这是系统兜底补全，建议自定义」，避免把不合规候选静默推给作者。
    """
    fills = _FALLBACK_FIELD_FILL.get(key, {})
    repaired: list[dict] = []
    for o in options:
        item = dict(o)
        for field, fallback_val in fills.items():
            if field == "beats":
                val = item.get("beats")
                if not (isinstance(val, list) and all(str(b or "").strip() for b in val)):
                    item[field] = list(fallback_val)
            elif not str(item.get(field) or "").strip():
                item[field] = fallback_val
        item["fallback"] = True
        repaired.append(item)
    return repaired


# 中文无实义高频字（助词/代词/介词/连词/语气词），归一化时剔除，
# 避免把"的了在是"这类共同虚词误判为内容雷同
_NON_SEMANTIC_CHARS = set(
    "的了着过在是这和也就都而被把让我要你他她它它们们我们你们自己的什么怎么"
    "与或及对向从用靠给由将正在已经不太也会能给其很最更又再还边里头中后前上下"
    "于为到往和叫做像如但然而因为所以虽然如果就是还是可以应该可能似乎好像那么"
)


def _extract_anchor_ngrams(text: str, n: int) -> set[str]:
    """从已定核心事件文本提取锚定 n-gram（去虚词后的连续实义片段，如"登记表/志愿/机械"）。

    用于 narrative/execution 候选的「锚定已定事件」校验：候选只要命中至少一个锚定 n-gram，
    就说明它建立在已定事件之上，而非另写新场景/新事件。
    """
    chars = _normalize_chars(text)
    if len(chars) < n:
        return set()
    return {"".join(chars[i:i + n]) for i in range(len(chars) - n + 1)}


def _anchored_on_event(candidate_text: str, goal_text: str) -> bool:
    """候选文本是否命中已定核心事件的锚定词（3 字优先，2 字兜底）。

    goal_text 为空（goal 维度自身/无前序）时返回 True（不校验）。
    """
    if not goal_text:
        return True
    cand = "".join(_normalize_chars(candidate_text))
    if not cand:
        return False
    if any(g in cand for g in _extract_anchor_ngrams(goal_text, 3)):
        return True
    return any(g in cand for g in _extract_anchor_ngrams(goal_text, 2))


def _option_full_text(key: str, o: dict) -> str:
    """拼出候选文本 + 各结构化字段全文，用于锚定校验（beats 列表转文本）。"""
    parts = [str(o.get("text") or "")]
    for f in ("entry", "tone", "ending_hook", "satisfaction", "core_conflict", "protagonist_arc", "time_slice", "pace", "pov"):
        if str(o.get(f) or "").strip():
            parts.append(str(o[f]))
    beats = o.get("beats")
    if isinstance(beats, list):
        parts.extend(str(b) for b in beats if str(b or "").strip())
    return "".join(parts)


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
    task_type = "planning"
    temperature = 0.4
    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        """装配章节规划上下文：复用大纲师素材，注入当前维度定义/前序已定选择/历史修改意见
        与「上一轮被拒」重试提示，生成单维度候选。"""
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
                "\n\n【上一轮被拒】你上一轮为「" + dim["label"] + "」生成的 3 个选项被自动判定"
                "不合规（" + reason + "）。本轮必须彻底换一批：3 个选项互不重叠，禁止沿用上一轮"
                "任何选项的内容或换措辞复述；并且严格遵守本维度定义——" + dim["hint"] + "。"
                "所有选项必须落在同一时间切片、调性/爽感浓度一致。"
                "尤其 narrative 维度只能给「节奏档位+开场切入+视角+风格基调+进入方式」五要素齐备的"
                "叙事方案，不得写具体事件，更不得把已定核心事件换成另一个系统激活场景。"
                "若被拒的是 goal 维度且蓝图声明了系统/金手指、本章是开篇章，3 个选项必须全部锚定"
                "「金手指登场/觉醒」这一核心事件在同一时间切片下的互斥变体，禁止把系统从选项里拿掉。"
            )
            # 第 3 次生成=定向修复：前两轮都被拒，必须针对被拒原因逐项修正字段/锚定，这是最后一搏
            if retry.get("repair"):
                retry_text += (
                    "\n\n【定向修复·最后一次】这是第三次也是最后一次重试，除上面「换一批」外，你还必须"
                    "逐项对照被拒原因把问题修掉，确保本轮一次通过："
                    "①goal 维度：每个选项必须显式携带 time_slice/core_conflict/protagonist_arc 三个字段，"
                    "且 text 一句话本身就同时含「冲突双方+争的焦点+主角反应」，字段与 text 内容一致；"
                    "②narrative 维度：每个选项必须五要素字段齐备（pace/chapter_function/pov/tone/entry），"
                    "pace 字段必须同时含节奏档位词（慢/中/快、平缓/收紧…）与开场切入词（悬念/冷开场/日常…）；"
                    "③execution 维度：每个选项必须带 3-4 个非空的一句话 beats + ending_hook + satisfaction；"
                    "④narrative/execution 的 text 必须锚定【前序已定】的核心事件与叙事方案，严禁另写新事件、"
                    "严禁把已定事件换成另一个场景。若你自认为无法满足，宁可把 3 个选项收窄为同一事件的"
                    "同切面变体，也不要跨层混搭或另起炉灶。"
                )

        # 维度隔离：除了告诉模型「前面维度已定什么」，还要显式列出本维度不能写的内容
        # （其他维度负责的职责），防止模型把触发机制/具体事件/悬念等混进本维度候选
        # （真实问题：pace 候选写成「场景+系统激活」、把 entry 的活抢了）。
        forbidden_lines = "\n".join(f"- {f}" for f in (dim.get("forbidden") or []))
        forbidden_block = (
            "\n\n【禁止覆盖】\n以下内容已由其他维度负责，你这一维度不要写（写了就是抢占别的维度的职责，判不合规）：\n"
            + forbidden_lines
        ) if forbidden_lines else ""

        # 节奏参照注入（主线二：内置题材族骨架模板 + 自己书节奏仪表盘）：
        # 规划本章前看到「全书节奏坐标」——已写章节的标签序列、连续过渡章告警、
        # 距上一个爽点/高潮的距离、题材族前 30 章骨架参考。让每章选项不只是"本章视角"，
        # 而是落在全书节奏密度里（对应拆书教程"2-3 章一个爽点、过渡章不超 2 章、10 章一中高潮"）。
        rhythm_block = ""
        try:
            from app.agents.platform_rules import format_rhythm_skeleton
            from app.services.rhythm_service import (
                compute_rhythm_dashboard,
                format_stage_card,
            )

            try:
                cur_no = int(params.get("chapter_no") or 0)
            except (TypeError, ValueError):
                cur_no = 0
            from app.agents.context import get_active_blueprint

            blueprint = get_active_blueprint(self.db, novel_id)
            skeleton = format_rhythm_skeleton(
                getattr(novel, "background_type", None) if novel else None,
                (getattr(novel, "genres", None) if novel else None) or [],
            )
            dashboard = compute_rhythm_dashboard(self.db, novel_id, cur_no)
            stage_card = format_stage_card(blueprint, cur_no)
            rhythm_block = (
                "\n\n【全书节奏参照·规划本章前必读】本章节奏标签（rhythm_tag）的判定依据："
                "既要贴合本章自身功能，也要顾全书节奏密度——以下为参考坐标：\n"
                f"{skeleton}\n\n{dashboard}"
                + (f"\n\n{stage_card}" if stage_card else "")
            )
        except Exception:  # 节奏统计失败不影响规划主流程
            pass

        task_instruction = f"""
【本次任务】
在下面 {len(PLAN_DIMENSIONS)} 个维度中，你负责生成第 {idx + 1} 个维度「{dim['label']}」的候选选项。
{len(PLAN_DIMENSIONS)} 个维度的顺序：{order_lines}。

【本维度职责】
{dim['hint']}{forbidden_block}

【前序已定】
作者在前面维度已选定：
{sel_lines}{directives_text}{retry_text}

请基于素材并顺着上面已定取值，为「{dim['label']}」生成恰好 3 个相互区分、覆盖不同走向的候选选项，
输出严格的 JSON：{{"dimension": {{"key": "{dim['key']}", "label": "{dim['label']}", "hint": "{dim['hint']}", "options": [3 个选项]}}}}。
"""
        user_content = base.messages[-1]["content"] + "\n\n" + rhythm_block + "\n\n" + task_instruction
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
        """把 LLM 返回的单个维度 3 个候选 JSON 解析为 ChapterPlanDimensionProposal。"""
        return ChapterPlanDimensionProposal.model_validate_json(text.strip())
