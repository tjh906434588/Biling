"""场景规划师（Scene Planner）：10 个维度定稿后，把本章拆成 3-5 个场景逐字段确认。

作者在「本章规划」里已逐项确认 10 个维度（核心事件/节奏开场/视角/节拍/结尾钩子/进入触发/
风格基调/主角反应弧/核心冲突/爽点类型）。正文生成前，场景规划师基于这些选择 + 与大纲师同一套素材，
把这一章拆成 3-5 个可演的场景，每个场景五个字段（地点/出场人物/目标/冲突/结果）各给
5 个固定不重复候选（+ 前端 1 个自定义输入）。作者在「场景卡片」内逐字段单选/自定义，
全部场景确认后拼成「场景执行清单」注入小说家作为硬约束（不得增删场景、不得改变每场景的
「目标→冲突→结果」）。

场景确认完之后，每个场景扩写前再调一次本角色（proposal 模式）：针对该场景生成 5 个
约 100 字的写法提案（梗概），作者六选一（5 提案 + 自定义，或「都不满意，重新生成」），
选定后由小说家按该提案扩写成正文——把写法的随机性提前暴露给作者，而不是藏在正文里。
"""
import uuid

from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_chapter_author_directives, get_novel
from app.agents.outliner import OutlinerAgent
from app.agents.platform_rules import format_blueprint_rhythm_rules, format_genre_storytelling_rules
from app.schemas.agents import ScenePlanProposal, SceneProposalsProposal

# 场景五字段的固定顺序与说明（LLM 输出、stream.py 组装、前端卡片展示共用）
SCENE_FIELDS: list[dict] = [
    {"field": "location", "label": "地点", "hint": "这个场景发生在哪（具体到可演的空间，如「拍卖行二楼包厢」）"},
    {"field": "participants", "label": "出场人物", "hint": "谁在场（主角必在，其余为本场景相关的角色，少而聚焦）"},
    {"field": "goal", "label": "目标", "hint": "这个场景要达成什么（主角或在场者的意图）"},
    {"field": "conflict", "label": "冲突", "hint": "阻力是什么（越具体越可演，如「神秘买家突然抬价、主角资金不足」）"},
    {"field": "outcome", "label": "结果", "hint": "场景结束时状态发生了什么变化（推进下一场景的衔接点）"},
]

SCENE_PLAN_PROMPT = """你是「场景规划师」。作者已在「本章规划」里确认了 10 个维度（本章核心事件/节奏开场/视角/节拍/结尾钩子/进入触发/风格基调/主角反应弧/核心冲突/爽点类型），现在轮到你把这 10 个维度的选择落地成"可演的场面"：把这一章拆成 **3-5 个场景**，每个场景用五个字段（地点/出场人物/目标/冲突/结果）描述，每个字段给出 **恰好 5 个相互区分、覆盖不同类型** 的候选选项（作者在卡片内逐字段单选，也可对该字段自行输入，所以选项要真正给到不同选择，不要凑数）。输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{"scenes": [
  {"scene_index": 1, "fields": [
    {"field": "location", "label": "地点", "hint": "…", "options": [{"id": "s1_location_1", "text": "候选1"}, …5个]},
    {"field": "participants", "label": "出场人物", "hint": "…", "options": […5个]},
    {"field": "goal", "label": "目标", "hint": "…", "options": […5个]},
    {"field": "conflict", "label": "冲突", "hint": "…", "options": […5个]},
    {"field": "outcome", "label": "结果", "hint": "…", "options": […5个]}
  ]},
  …共 3-5 个场景
]}

铁律：
- 场景数 3-5 个，必须【完整覆盖整章】：从开场进入，经中间推进，到结尾钩子收尾；结尾钩子要落在最后一个场景。每个场景的「结果」与下一场景的开头要能自然衔接，整章连起来是一段连贯的戏。
- fields 顺序固定为 location → participants → goal → conflict → outcome，一个场景恰好 5 个字段，每个字段恰好 5 个候选，id 形如 `s<场景序号>_<字段名>_<序号>`；同一字段的 5 个候选必须相互区分、覆盖不同走向（如地点的 5 个候选是 5 种不同的可演空间，冲突的 5 个候选是 5 种不同的阻力来源），不要给大同小异的选项。
- 每个候选都紧扣本章真实素材（主角身份/当前处境/金手指或系统类型/蓝图走向/最近故事状态/账本里超期或紧迫的 open 项/未回收伏笔），并且要严格接住作者已确认的 10 个维度：
  - 把「节拍序列（beats）」的每一步落进对应场景，场景的节奏要符合「节奏/开场」维度选定的节奏功能（climax/turning 加快、buildup/interlude 舒缓）；
  - 最后一场景必须把「结尾钩子（ending_hook）」演出来；
  - 全章贯穿「风格基调」「爽点类型」，主角的态度按「主角反应弧」从 A 走到 B；
  - 「核心冲突落点」必须作为至少一个场景的主要冲突。
- 演法匹配主角当前能力与阶段：刚觉醒/刚入职等弱小时期的场景只能安排符合其底牌的小胜或间接反击，禁止"新人当众拆台前辈/上级"这类需要实力与地位支撑的强打脸。
- 金手指/系统不必每章现身：戏眼应落在**真实事件与真实结果**上（主角做了什么、对手怎么回应、局面怎么变、拿到什么现实回报），金手指/系统作为工具在需要时亮一下即可；若本章规划没定金手指高光，不要硬塞系统戏进去。
- 场景不要重复同一冲突：3-5 个场景的冲突要递进或错开，别在同一件事上原地打转。
- 素材不足以判断时，按素材里最明显的推进需求（如超期伏笔、主线冲突）落场景，不要编造素材里不存在的设定。
"""

SCENE_PROPOSAL_PROMPT = """你是「场景规划师」（提案模式）。作者已经确认了本章规划与某一场景的骨架（地点/出场人物/目标/冲突/结果），现在请你为**这一场戏**生成 **恰好 5 个相互区分、写法明显不同** 的写法提案，每个提案是一段 **约 100 字** 的梗概，讲清这场戏"怎么演"：开场怎么切入 → 中间怎么推进 → 冲突怎么爆发 → 怎么收束，要具体到动作、对话、反应与情绪，而不是"主角与对手交锋"这类总结性空话。作者会在 5 个提案里六选一（也可自定义），选定后小说家按该提案扩写成正文。输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{"scene_index": <场景序号>, "proposals": [
  {"id": "prop_1", "text": "约100字梗概1"},
  {"id": "prop_2", "text": "约100字梗概2"},
  {"id": "prop_3", "text": "约100字梗概3"},
  {"id": "prop_4", "text": "约100字梗概4"},
  {"id": "prop_5", "text": "约100字梗概5"}
]}

铁律：
- proposals 必须恰好 5 个；5 个提案的【切入方式与叙事重心要明显不同】（如：冷开场直接抛冲突 / 环境细节先行、慢热铺垫 / 以对话交锋推进 / 以动作与场面推进 / 以反差或悬念切入），让作者有真正的"写法"选择。
- 每个提案都必须完整覆盖该场景的「目标→冲突→结果」，不增删、不改变这三个要素；结尾落在该场景的「结果」上，为下一场景留好衔接。
- 人物言行符合素材里的性格与关系（尤其注意设定卡/实体关系/最近故事状态），贴合该场景确认的「地点」与「出场人物」，不引入场景人物表之外的新角色。
- 风格符合本章已确认的「风格基调」与「爽点类型」，节奏贴合「节奏/开场」维度选定的节奏功能；禁止在弱小时期安排需要实力地位支撑的强打脸。
- 梗概用简练的中文叙述，约 100 字（60-140 字都算合格），不要写"本章将"这类规划腔，要像可以照着写的场记。
"""


class ScenePlannerAgent(Agent[ScenePlanProposal]):
    task_type = "setting"
    temperature = 0.4
    mock_output = {
        "scenes": [
            {
                "scene_index": 1,
                "fields": [
                    {"field": "location", "label": "地点", "hint": "…", "options": [
                        {"id": "s1_location_1", "text": "拍卖行二楼包厢"},
                        {"id": "s1_location_2", "text": "拍卖行大厅竞价区"},
                        {"id": "s1_location_3", "text": "拍卖行后台寄存处"},
                        {"id": "s1_location_4", "text": "拍卖行走廊休息角"},
                        {"id": "s1_location_5", "text": "拍卖行大门外台阶"},
                    ]},
                    {"field": "participants", "label": "出场人物", "hint": "…", "options": [
                        {"id": "s1_participants_1", "text": "主角、拍卖师、神秘买家"},
                        {"id": "s1_participants_2", "text": "主角、拍卖师"},
                        {"id": "s1_participants_3", "text": "主角、神秘买家、侍应"},
                        {"id": "s1_participants_4", "text": "主角、同行竞拍者"},
                        {"id": "s1_participants_5", "text": "主角、拍卖行经理、鉴定师"},
                    ]},
                    {"field": "goal", "label": "目标", "hint": "…", "options": [
                        {"id": "s1_goal_1", "text": "主角想低调拍下那件赝品"},
                        {"id": "s1_goal_2", "text": "主角确认赝品是否在场"},
                        {"id": "s1_goal_3", "text": "主角试探神秘买家的底细"},
                        {"id": "s1_goal_4", "text": "主角在预算内拿下目标拍品"},
                        {"id": "s1_goal_5", "text": "主角先按兵不动观察局势"},
                    ]},
                    {"field": "conflict", "label": "冲突", "hint": "…", "options": [
                        {"id": "s1_conflict_1", "text": "神秘买家突然抬价，主角资金不足"},
                        {"id": "s1_conflict_2", "text": "拍卖师报错起拍价，现场起哄"},
                        {"id": "s1_conflict_3", "text": "鉴定师当众质疑拍品来源"},
                        {"id": "s1_conflict_4", "text": "主角被人认出，身份将暴露"},
                        {"id": "s1_conflict_5", "text": "有人抢先以底价拿走了拍品"},
                    ]},
                    {"field": "outcome", "label": "结果", "hint": "…", "options": [
                        {"id": "s1_outcome_1", "text": "主角放弃竞价，却发现神秘买家是自己人"},
                        {"id": "s1_outcome_2", "text": "主角借势压价成功拿下拍品"},
                        {"id": "s1_outcome_3", "text": "主角按兵不动，记住神秘买家"},
                        {"id": "s1_outcome_4", "text": "主角暴露身份，被请进贵宾室"},
                        {"id": "s1_outcome_5", "text": "主角空手离场，但拿到关键线索"},
                    ]},
                ],
            }
        ]
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        # 复用大纲师的素材组装（与大纲/章节规划同一套上下文），仅替换 system prompt 与任务指令。
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
        if genre_block:
            genre_block = "\n\n" + genre_block
        rhythm_block = ("\n\n" + rhythm_block) if rhythm_block else ""

        scene_task = params.get("scene_task") or "plan"

        # 作者对本章的历史修改意见（意见持久化）：规划/提案必须规避作者已否决的剧情
        directives = get_chapter_author_directives(self.db, novel_id, params.get("chapter_no"))
        directives_text = ""
        if directives:
            directives_text = "\n".join(f"- {d['text']}" for d in directives)
            directives_text = (
                "\n\n作者对本章的历史修改意见（作者在之前版本明确指出过的问题，"
                "所有候选与提案必须规避或修正，不得再次出现）：\n" + directives_text
            )

        if scene_task == "plan":
            plan = params.get("chapter_plan") or {}
            plan_lines = "\n".join(
                f"- {label}：{plan.get(key) or '（未定）'}"
                for key, label in (
                    ("goal", "本章核心事件"),
                    ("pace", "节奏/开场"),
                    ("pov", "视角"),
                    ("beats", "节拍序列"),
                    ("ending_hook", "结尾钩子"),
                    ("entry", "进入/触发"),
                    ("tone", "风格基调"),
                    ("protagonist_arc", "主角反应弧"),
                    ("core_conflict", "核心冲突"),
                    ("satisfaction", "爽点类型"),
                )
            )
            system_prompt = SCENE_PLAN_PROMPT + genre_block + rhythm_block
            task_instruction = f"""
【本次任务】
作者已确认的「本章规划」（10 个维度）：
{plan_lines}

请把上面这 10 个维度的选择落地成 3-5 个可演的场景，每个场景五字段（地点/出场人物/目标/冲突/结果），
每字段恰好 5 个候选选项。fields 顺序固定为 location → participants → goal → conflict → outcome。
输出严格的 JSON：{{"scenes": [3-5 个场景]}}。{directives_text}
"""
        else:  # proposal
            candidate = params.get("scene_candidate") or {}
            scene_lines = "\n".join(
                f"- {label}：{candidate.get(field) or '（未定）'}"
                for field, label in (
                    ("location", "地点"),
                    ("participants", "出场人物"),
                    ("goal", "目标"),
                    ("conflict", "冲突"),
                    ("outcome", "结果"),
                )
            )
            plan = params.get("chapter_plan") or {}
            system_prompt = SCENE_PROPOSAL_PROMPT + genre_block + rhythm_block
            task_instruction = f"""
【本次任务】
目标场景：第 {params.get('scene_index', '?')} 场。该场景的骨架（作者已确认）：
{scene_lines}

本章基调：{plan.get('tone') or '（未定）'}；本章节奏/开场：{plan.get('pace') or '（未定）'}；本章爽点：{plan.get('satisfaction') or '（未定）'}。

请为该场景生成恰好 5 个写法明显不同的提案（每个约 100 字梗概），输出严格的 JSON：
{{"scene_index": {params.get('scene_index', 1)}, "proposals": [5 个提案]}}。{directives_text}
"""
        user_content = base.messages[-1]["content"] + "\n\n" + task_instruction
        return ContextPack(
            novel_id=novel_id,
            agent="scene_planner",
            system_prompt=system_prompt,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            components=base.components,
            meta={"params": params, "scene_task": scene_task},
            temperature=0.4 if scene_task == "plan" else 0.7,
        )

    def parse_output(self, text: str):
        # build_context 把模式放进 meta，但 parse_output 只拿到文本；用文本结构自判（scenes vs proposals）
        stripped = text.strip()
        if '"proposals"' in stripped and '"scene_index"' in stripped:
            return SceneProposalsProposal.model_validate_json(stripped)
        return ScenePlanProposal.model_validate_json(stripped)
