"""风格提取师（Style Extractor）：从导入大纲文档提炼"全局文风描述"候选。

用于「v4 换内容时自动更新风格」：蓝图生成后自动提取新文档中的风格/文风要点，
前端展示给作者对比当前 style_directive，确认后写入（不自动覆盖）。
"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.schemas.agents import StyleExtraction

SYSTEM_PROMPT = """你是「风格提取师」。从作者的大纲文档中，找出所有关于"写作风格、文风基调、叙事节奏、题材标签、对标作品、创作参考、语言特点、氛围质感"的表述，提炼成一段可直接作为"全局文风描述"使用的简洁文字。

输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{
  "style_directive": "提炼后的全局文风描述"
}

要求：
- 只提炼文档里明确写出的风格类信息，不得凭空编造或扩写；
- 用作者的原话风格归纳，保留关键措辞（如"硬核真实、克制白描""对标作品：《XXX》""无系统面板"等具体信息）；
- 篇幅控制在 200 字以内，作为一段连贯的中文描述；
- 如果文档里没有任何风格类内容，style_directive 输出空字符串 ""。
"""


class StyleExtractorAgent(Agent[StyleExtraction]):
    task_type = "setting"
    temperature = 0.2

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        source_doc = params.get("source_doc", "")[:16000]
        title = params.get("title") or str(novel_id)
        user_content = (
            f"项目：《{title}》\n\n"
            f"以下是作者的大纲文档：\n\n{source_doc}\n\n"
            f"请提炼其中的风格/文风/对标/创作参考要点，输出上述 JSON。"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="style_extractor",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> StyleExtraction:
        return StyleExtraction.model_validate_json(text.strip())
