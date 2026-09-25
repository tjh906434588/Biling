"""大纲方向提案师（Direction Proposer）：生成大纲前咨询作者「下一步发展脉络方向」。

作者提供的是蓝图大方向，细节可能不完善/矛盾；AI 直接默认生成不一定符合作者意图。
方案：每次生成新章大纲前，先基于与大纲师同一套素材（蓝图/故事状态/设定/账本/关系），
产出 3 个相互区分的「下一步走向」候选，交给作者选择（或自定义输入），
作者确认后再注入大纲师正式生成——作者把控故事发展脉络。
"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.outliner import OutlinerAgent
from app.schemas.agents import DirectionProposal

SYSTEM_PROMPT = """你是「大纲方向提案师」。在大纲师正式写某一章大纲之前，你先替作者想清楚：这一章（以及紧接着的几章）故事往哪个方向发展。

你会收到与大纲师完全相同的素材：项目、蓝图、相关设定、最近故事状态、伏笔账本、实体关系、已写章节标题、作者要求。

请基于这些素材，产出 3 个「下一步发展脉络方向」候选，让作者选择（或作者自己写一个）。输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{"directions": [
  {"id": "a", "label": "方向名（6 字以内的短标题）", "desc": "一句话说明：这一章怎么走、会引出什么、为什么这样走"},
  {"id": "b", "label": "方向名", "desc": "..."},
  {"id": "c", "label": "方向名", "desc": "..."}
]}

铁律：
- 3 个方向必须【相互区分、覆盖不同类型的走向】，让作者有真正的选择：
  例如：A=正面推进主线（回收在即的伏笔/兑现冲突），B=引入新变数（新角色/新冲突/新场景搅动局面），
  C=深化人物关系或铺垫转折（为后面的高潮蓄势）。不要给三个大同小异的选项。
- 每个方向都要紧扣当前剧情真实状态：基于最近故事状态的下一步（next_chapter_implications）、
  账本里超期/紧迫的 open 项、蓝图分卷目标、未回收伏笔——不要脱离素材空想。
- 方向要对「这一章」可执行（大纲师要照着写这一章），desc 里说清本章走向即可，不要展开整卷。
- 作者已指定本章目标/节奏功能/视角时，3 个方向都要在遵守作者要求的前提下区分走向。
- 素材不足以判断时，按素材里最明显的推进需求（如超期伏笔、主线冲突）给出方向，不要编造素材里不存在的设定。
"""


class DirectionProposerAgent(Agent[DirectionProposal]):
    task_type = "setting"
    temperature = 0.4
    mock_output = {
        "directions": [
            {"id": "a", "label": "正面推进主线", "desc": "兑现账本里紧迫度最高的伏笔，让主角与对手正面交锋"},
            {"id": "b", "label": "引入新变数", "desc": "一个新角色/新线索搅动当前局面，打破僵局"},
            {"id": "c", "label": "深化人物关系", "desc": "借日常场景推进主角与关键人物的关系，埋下后续转折"},
        ]
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        # 复用大纲师的素材组装（与正式大纲生成同一套上下文，保证提案与产出一致），
        # 仅替换 system prompt 为方向提案指令，输出协议不同。
        base: ContextPack = OutlinerAgent(self.db).build_context(novel_id, params)
        return ContextPack(
            novel_id=novel_id,
            agent="direction_proposer",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": base.messages[-1]["content"]},
            ],
            components=base.components,
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> DirectionProposal:
        return DirectionProposal.model_validate_json(text.strip())
