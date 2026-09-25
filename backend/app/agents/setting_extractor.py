"""设定抽取师（Setting Extractor）：从导入的大纲/蓝图文档中抽取可沉淀进设定库的设定。

导入蓝图时，蓝图师先把文档规范化为 Blueprint 落库；本角色再把导入文档里的
角色/地点/势力/世界规则/物品/概念抽取出来，沉淀为「待确认概念卡片」
（走概念师同款 ConceptExtraction → _persist_concept 链路），由作者在「设定」页确认转正。
"""
import uuid

from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_novel, get_settings_snapshot, format_settings_for_prompt
from app.schemas.agents import ConceptExtraction
from app.services.era_industry import format_era_research_for_prompt

SYSTEM_PROMPT = """你是「设定抽取师」，从导入的外部大纲/蓝图文档中抽取可沉淀进设定库的设定。
只抽取「能沉淀为设定」的内容，类型只能是以下六种之一，且与设定库一一对应：
- character 角色：会说话、有自我意识的（活物/系统有嘴也算）；
- location 地点：故事发生的场所；
- faction 势力：组织/家族/帮派/阵营；
- world_rule 世界规则：这个世界的法则，所有角色都遵守；
- item 物品：实体的、拿得到的道具；
- concept 概念：世界观里的特有名词/机制。

规则：
- 只抽取文档里明确写出的设定；拿不准时用 questions_to_ask 提示作者确认，不要硬抽；
- 角色优先从人物弧光/角色清单提取，世界规则优先从规则条目提取，不要凭空捏造；
- 与设定库摘要中同名的设定**也要抽取出来**（用于覆盖更新设定库），并用 conflicts_with_existing 说明与旧设定的差异；
- 相近/重复的概念合并，重点条目优先，总量控制在 15 条以内，避免罗列式刷屏；
- 每个 concept 的 extracted 必须包含 description 字段——一段完整、可直接作为该设定描述的话；
  其余字段按类型补充（角色：appearance/personality/role_in_story；地点：features/atmosphere；
  物品：function/limitations 等）；
- 机构档案模板（faction 专属）：type 为 faction 时，extracted 必须按机构档案维度展开——
  成立时间、负责人、人员规模、业务范围、位置布局、时代特征，能判断的维度各写一个键值字段
  （如 "业务范围": "职业介绍、招工代理"），判断不出的维度不写、不要硬编；
  文档里的机构老板若另有独立人物描写，单独再抽一条 type=character；
- raw_quote 填文档中对应的原文片段（尽量短）。

【出现时机（重要）】根据文档描述判断该设定在故事中是「全程存在」还是「特定阶段/章节才登场」，写入 extracted：
- stages：生效的故事阶段，可多选：early（前期）/ middle（中期）/ late（后期）；文档未限定则不写；
- appear_from / appear_until：能判断出大致登场章号时填写（正整数）；只能判断阶段、判断不出章号就只写 stages；
- appear_ranges：需要限定多段不连续范围时用：[{ "from": 1, "until": 10 }, { "from": 50, "until": 80 }]；
  与 appear_from / appear_until 二选一；
- role_rank：仅 type 为 character 时必填：protagonist（主角）/ major（重要配角）/ minor（次要配角）/ extra（龙套）。
- importance：该设定对全书的长期重要性：high（贯穿主线/世界观基石/后期必回收）、medium（常规）、low（一次性细节）。
  只对「窗口外也必须长期记住」的设定标 high——会被固化，注入设定库时永远不被数量上限挤出。
文档里写明「后期/前期/中期才出现」「第 X 章之后」「故事后半段」等，必须如实转成上面的字段；
文档没提到时机的，不要脑补，留空 = 不限制（全程有效）。

输出必须是严格的 JSON，格式：
{"concepts": [{"type": "character|location|faction|world_rule|item|concept",
  "name": "概念名", "raw_quote": "文档原话片段",
  "extracted": {"description": "一段完整描述", "其他类型字段": "...",
                "stages": ["early"], "appear_from": 5, "appear_until": 20,
                "appear_ranges": [], "role_rank": "major"},
  "conflicts_with_existing": ["与已有设定的冲突说明或空"],
  "questions_to_ask": ["追问"]}],
 "follow_up_questions": []}
"""


class SettingExtractorAgent(Agent[ConceptExtraction]):
    task_type = "setting"
    temperature = 0.3
    mock_output = {
        "concepts": [
            {
                "type": "character",
                "name": "岚",
                "raw_quote": "女主是个占卜师",
                "extracted": {
                    "description": "银发红瞳的占卜师，冷静隐忍，是故事的女主。",
                    "appearance": "银发红瞳",
                    "personality": ["冷静", "隐忍"],
                    "role_in_story": "女主",
                },
                "conflicts_with_existing": [],
                "questions_to_ask": ["她的魔法来源是什么？"],
            }
        ],
        "follow_up_questions": [],
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        existing = format_settings_for_prompt(get_settings_snapshot(self.db, novel_id))
        doc_name = (params.get("doc_name") or "导入的大纲文档").strip()
        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n\n"
            f"已有设定摘要（避免重复抽取）：\n{existing}\n\n"
            f"【{doc_name}】\n{params.get('text', '')}"
        )
        # 年代×行业研究（运行时按需生成，落库 novel.era_research；无研究或纯架空则空）
        era_block = format_era_research_for_prompt(novel.era_research if novel else None)
        if era_block:
            user_content = user_content + "\n\n" + era_block
        return ContextPack(
            novel_id=novel_id,
            agent="setting_extractor",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ConceptExtraction:
        return ConceptExtraction.model_validate_json(text.strip())
