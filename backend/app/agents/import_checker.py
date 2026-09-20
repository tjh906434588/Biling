"""核对师（Import Checker）：把导入的大纲文档与蓝图师产出的蓝图逐节比对，找出"文档有、蓝图没收录/不全"。

用于「导入后自动校验比对」：蓝图师把导入文档整理成结构化蓝图后，本角色再回头逐节核对，
把文档里没被蓝图收录（或只收了一半）的内容列出来，前端展示给作者人工确认、决定是否补充。
"""
import re
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.schemas.agents import BlueprintCheck

SYSTEM_PROMPT = """你是「核对师」，负责把作者的导入大纲文档与蓝图师产出的蓝图做逐节比对，找出"文档里有、蓝图里没收录或收录不全"的内容，防止关键设定在整理过程中丢失。

输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{
  "total_sections": 文档章节总数,
  "missing": [
    {
      "section": "文档章节名",
      "coverage": "full|partial|missing",
      "doc_excerpt": "文档该章节中的关键内容摘录（不超过150字，必须出自原文）",
      "blueprint_field": "蓝图承接该内容的字段",
      "note": "说明：缺了哪些点，或哪些只收录了一半"
    }
  ]
}

判定规则：
- full：该章节的核心内容在蓝图中完整收录（语义一致即算，不要求逐字相同）；
- partial：核心内容只收录了一部分（如文档列了 9 条规则、蓝图只收了 3 条；文档给了分卷字数、蓝图 volumes 没写 word_count；文档给了主角性格、蓝图 personality 缺失）；
- missing：该章节的核心内容在蓝图中完全找不到对应。
- 每个文档章节都要输出一条记录（full/partial/missing 都列出），不要漏章。
- 核心内容指具体的规则、数字、人名、机构名、剧情逻辑、时序、风格/文风要求、创作参考、对标作品、支线名、爽点等，泛泛套话不算。
- blueprint_field 填蓝图对应字段名（如 notes / world_rules / character_arcs / volumes / subplots / total_word_count / total_chapters / foreshadowing_plan / 未收录），不确定就填"待人工确认"。
- doc_excerpt 必须引用文档原文，禁止编造。蓝图 notes 等字段已收录的内容，若语义一致视为 full。
"""


class ImportCheckerAgent(Agent[BlueprintCheck]):
    task_type = "review"
    temperature = 0.2

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        doc_text = params.get("doc_text", "")
        blueprint_text = params.get("blueprint_text", "")
        user_content = (
            f"以下是导入的大纲文档（已按章节切分，每节以【标题】开头）：\n\n"
            f"{doc_text}\n\n"
            f"==========\n\n"
            f"以下是蓝图师生成的蓝图（所有字段逐条展开）：\n\n"
            f"{blueprint_text}\n\n"
            f"请逐节比对文档与蓝图，输出上述 JSON（每个文档章节一条记录）。"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="import_checker",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> BlueprintCheck:
        raw = text.strip()
        # 容忍 LLM 输出包在 markdown 代码围栏里、或首尾夹带多余说明文字：提取 JSON 主体再解析
        if not raw.startswith("{"):
            m = re.search(r"\{[\s\S]*\}", raw)
            if m:
                raw = m.group(0)
        return BlueprintCheck.model_validate_json(raw)
