"""章节规划师（Chapter Planner）：写正文前咨询作者「本章规划」，合并大纲环节。

作者提供的是蓝图大方向，AI 直接默认生成正文不一定符合作者意图；
且逐章大纲费时费力（没人真的逐章写大纲）、AI 大纲质量不稳定、调完大纲也不保证
正文符合作者想法。方案：写正文前弹窗给出 3 套「本章规划」候选（标题/目标/节奏
功能/视角/3-4 节拍/结尾钩子），作者选择或自定义，确认后直接据此写正文——
规划即大纲（轻量版），落库为 approved outline 保持下游（评价师对照/记忆层/
账本）兼容。
"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.outliner import OutlinerAgent
from app.schemas.agents import ChapterPlanProposal

SYSTEM_PROMPT = """你是「章节规划师」。在小说家正式写某一章正文之前，你先替作者想清楚：这一章怎么写才符合作者的蓝图与当前剧情。

你会收到与大纲师相同的素材：项目、蓝图、相关设定、最近故事状态、伏笔账本、实体关系、已写章节标题、作者要求。

请基于这些素材，产出 3 套相互区分的「本章规划」候选，让作者选择（或作者自己写一套）。输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{"plans": [
  {"id": "a", "label": "规划名（6 字以内短标题）", "desc": "一句话说明：这一章怎么走、会引出什么、为什么这样走",
   "title": "本章标题（简洁有力）", "goal": "本章目标（一句话，完成后读者应该感受到什么变化）",
   "chapter_function": "progression|buildup|turning|climax|revelation|resolution|interlude",
   "pov": "本章视角角色名", "beats": ["节拍1一句话", "节拍2一句话", "节拍3一句话", "节拍4一句话(可3个)"],
   "ending_hook": "结尾钩子（一句话，勾住读者点下一章）"},
  {"id": "b", ...}, {"id": "c", ...}
]}

铁律：
- 3 套规划必须【相互区分、覆盖不同类型的走向】，让作者有真正的选择：
  例如：A=正面推进主线（回收在即的伏笔/兑现冲突），B=引入新变数（新角色/新冲突/新场景搅动局面），
  C=深化人物关系或铺垫转折（为后面的高潮蓄势）。不要给三套大同小异的规划。
- 每套规划都紧扣当前剧情真实状态：基于最近故事状态的下一步（next_chapter_implications）、
  账本里超期/紧迫的 open 项、蓝图分卷目标、未回收伏笔——不要脱离素材空想。
- chapter_function 决定节奏（climax/turning 加快节奏，buildup/interlude 可舒缓）；作者已指定
  本章节奏功能/视角/目标时，3 套规划都要在遵守作者要求的前提下区分走向。
- beats 3-4 个即可，每个一句话，讲清楚这一节发生什么、情绪如何；不要太长。
- ending_hook 必须具体可执行（如"主角接到一通陌生来电，对方叫出了他从未告诉过别人的名字"），
  不要写"留下悬念"这种空话。
- 节奏适配网文读者：受挫/吃瘪后一两章内要打脸回去，但为情节服务，不是为快而快；打脸的规模与方式必须匹配主角当前能力/身份/阶段——刚觉醒、刚入职等弱小时期只能安排符合其底牌的小胜或间接反击，禁止"新人当众拆台前辈/上级"这类需要实力与地位支撑的强打脸，大爽点留给主角攒足底牌之后。
- 素材不足以判断时，按素材里最明显的推进需求（如超期伏笔、主线冲突）给出规划，不要编造素材里不存在的设定。
"""


class ChapterPlannerAgent(Agent[ChapterPlanProposal]):
    task_type = "setting"
    temperature = 0.4
    mock_output = {
        "plans": [
            {
                "id": "a",
                "label": "正面推进主线",
                "desc": "兑现账本里紧迫度最高的伏笔，让主角与对手正面交锋",
                "title": "当面锣对面鼓",
                "goal": "主角与对手首次正面交锋并取得小胜，主线冲突正式点燃",
                "chapter_function": "climax",
                "pov": "主角",
                "beats": [
                    "对手登门摊牌，双方对峙气氛拉满",
                    "主角用前文埋下的筹码反击，局势逆转",
                    "账本伏笔当场回收，读者恍然大悟",
                    "留下新线索，引出下一章目标",
                ],
                "ending_hook": "对手留下一句话：你以为这就完了？",
            },
            {
                "id": "b",
                "label": "引入新变数",
                "desc": "一个新角色/新线索搅动当前局面，打破僵局",
                "title": "不速之客",
                "goal": "新角色登场打破当前僵局，为后续冲突埋下新的变数",
                "chapter_function": "turning",
                "pov": "主角",
                "beats": [
                    "主角处理手头事务时被陌生来客打断",
                    "来客道出关键信息，主角发现局势比想象复杂",
                    "主角与来客各怀心思地达成临时合作",
                    "来客的真实目的露出一角",
                ],
                "ending_hook": "来客离开后，主角才意识到自己把什么带进了家门。",
            },
            {
                "id": "c",
                "label": "深化人物关系",
                "desc": "借日常场景推进主角与关键人物的关系，埋下后续转折",
                "title": "并肩之后",
                "goal": "深化主角与关键人物的羁绊，在轻松氛围中埋下沉重伏笔",
                "chapter_function": "buildup",
                "pov": "主角",
                "beats": [
                    "主角与关键人物共处一段日常，关系升温",
                    "闲聊中无意透露关键设定，二人反应微妙",
                    "一个细节让主角对关键人物产生新的疑虑",
                    "两人在岔路口分开，各怀心事",
                ],
                "ending_hook": "转过身的关键人物，脸上的笑慢慢淡了下去。",
            },
        ]
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        # 复用大纲师的素材组装（与正式大纲生成同一套上下文，保证规划与产出一致），
        # 仅替换 system prompt 为章节规划指令，输出协议不同。
        base: ContextPack = OutlinerAgent(self.db).build_context(novel_id, params)
        return ContextPack(
            novel_id=novel_id,
            agent="chapter_planner",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": base.messages[-1]["content"]},
            ],
            components=base.components,
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ChapterPlanProposal:
        return ChapterPlanProposal.model_validate_json(text.strip())
