"""蓝图质检师（Blueprint Prechecker）：导入蓝图前通读导入文档，找出文档「内部」的疑点。

与「核对师（import_checker，文档 vs 蓝图防丢失）」和蓝图师的 blueprint_conflicts
（文档 vs 设定库）互补：本角色只看导入文档自身——模糊没写清、前后矛盾，
整理成蓝图前逐条交给作者确认怎么处理（按建议修正 / 保持原文 / 自定义）。
"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_novel
from app.agents.platform_rules import (
    get_background_generation_scope,
    format_genres_direction,
)
from app.schemas.agents import BlueprintPrecheck

SYSTEM_PROMPT = """你是「蓝图质检师」，在把导入的大纲文档整理成蓝图之前，先通读文档，找出**文档内部**的疑点，供作者确认后修正。不生成蓝图，只输出疑点清单。

输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{
  "issues": [
    {
      "type": "vague|conflict|missing|quality|compliance",
      "item": "疑点对象（角色名 / 时间 / 设定项 / 数字 / 机构名等；quality/compliance 可填「整篇文档」）",
      "issue": "问题描述（一句话说清哪里模糊、哪里矛盾、缺了什么、什么质量问题、什么敏感内容）",
      "source": "文档原文摘录（不超过 80 字，必须出自原文；缺失类可填'（全文未提及）'）",
      "suggestion": "直接给出可替换原文的成段改写文本（必须本身就是修好的话，见下方铁律）",
      "options": "本条疑点要展示的处理选项 id 数组，从 apply（按建议处理）/ keep（保持原文）/ delegate（交由蓝图师自行把握）中挑选，缺省给全三个。原则：只给真正有意义的选项，能删就删——conflict 前后矛盾删 keep（保留原文等于保留两个打架的说法）；AI 建议已清晰到作者基本只会采纳、且没有必须保留原文的理由时只给 apply；delegate 与作者输入框作用重复（作者可直接在输入框里写让蓝图师自行把握）时可删 delegate。至少保留 1 个。"
    }
  ]
}

判定标准：
- vague（模糊没写清）：关键信息含糊其辞、语义无法确定——如"大约""好像""若干""某组织"、
  主角核心能力/金手指没写清楚、时间/数字模糊到整理进蓝图会产生歧义、同一处关键设定前后说法不一说不清。
- conflict（前后矛盾）：文档内部两处及以上说法互相冲突——如时间线打架（2000 入职 vs 2010 入职）、
  数字不一致（总章数 800 vs 500）、角色性格/结局前后相反、规则互相矛盾、同一设定多处不同说法。
- missing（关键信息缺失）：蓝图的必需要素全文都没写——如主角是谁、主角核心能力/金手指、
  故事发生的年代/时间线、核心冲突/主线目标、结局方向、核心配角。缺失到整理成蓝图会缺胳膊少腿。
  source 填"（全文未提及）"。
- quality（文档质量可疑）：整篇文档几乎无法使用——主体是乱码（大量不可读字符/替换符/无意义符号）、
  有效内容极少（全文没有实质性信息）、几乎全是空白/占位符。这种文档整理出的蓝图是废的。
  乱码时 source 摘录乱码片段（≤80 字）；整体过短填"（全文扫描）"。
- compliance（内容合规预警）：文档明确涉及平台可能下架的内容——暴力血腥（残忍虐杀/肢解）、
  露骨色情、政治敏感（攻击现行体制/煽动对立）。仅提示作者自行判断，不用逐条处理。
  普通打斗、恋爱描写不算。source 摘录相关片段（≤80 字）或填"（全文多处涉及）"。
- 只列真正影响蓝图质量的疑点；泛泛的修辞、文风描写、无关紧要的细节不列。
- 没发现问题就输出 {"issues": []}，不要硬凑。
- 同类问题多处出现只列一条（item 里写清楚涉及的对象与位置）。
- source 必须引用原文，禁止编造；确实无法定位到原文时填"（无法定位原文）"。

suggestion 铁律（最重要）：作者选「按建议处理」时，这条建议会被原样注入蓝图师，
所以它必须**本身就是一段修好的文字**，能直接替换原文，而不是"让 AI 再去做什么"的指示。
- vague：按最合理的解读，把模糊处直接写成清楚完整的句子（替换掉"大约/若干/某组织"等含糊表述）；
- conflict：先选定一致口径（通常取先出现且更具体的版本，简单说明取舍），再把冲突处写成统一的一段话；
- missing：基于文档已有信息合理推断，写出补全后的具体文本（开头标注【推断】）；
- compliance：写出去敏感化后的改写文本（替换敏感细节为合规表达），或明确"整句删除"。
- 绝对禁止"明确XX指什么""重算XX逻辑""补充XX""建议调整XX"这类元指令——那等于没建议；
  禁止只说"改为统一下"而不给出统一下到底是什么。
- 建议长度不限，把修好的话写完整，宁可长一点也不要含糊。
"""


class BlueprintPrecheckerAgent(Agent[BlueprintPrecheck]):
    task_type = "setting"
    temperature = 0.2
    mock_output = {
        "issues": [
            {
                "type": "conflict",
                "item": "主角入职时间",
                "issue": "前文说 2000 年入职江城人才信息服务部，后文又说 2010 年入职，时间线打架。",
                "source": "「2000年入职」「直到2010年才进入…」",
                "suggestion": "统一为前文的 2000 年入职，后文改为 2010 年离职创业。",
                "options": ["apply", "delegate"],
            },
            {
                "type": "vague",
                "item": "主角金手指",
                "issue": "只写了主角有特殊能力，但没有写清具体是什么、怎么触发。",
                "source": "「他拥有某种特殊的能力」",
                "suggestion": "改写为：『入职第一天，他意外觉醒一套天赋洞察系统，只要接触考生档案，就能看见该生与生俱来的禀赋分布（逻辑思维/动手实操/艺术感悟等九维），无需主动触发。』",
            },
        ]
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        import_source = (params.get("import_source") or "").strip()
        if not import_source:
            import_source = "（无导入文档）"
        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n"
            f"项目前提：{novel.premise if novel and novel.premise else '（未填）'}\n"
            f"世界背景类型：{(novel.background_type if novel else None) or 'realistic'}\n\n"
            f"{get_background_generation_scope(novel.background_type if novel else None)}\n\n"
            f"{format_genres_direction((novel.genres if novel else None) or [])}\n\n"
            f"导入的大纲文档（作者从外部生成，找出文档内部的疑点）：\n{import_source}"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="blueprint_prechecker",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> BlueprintPrecheck:
        return BlueprintPrecheck.model_validate_json(text.strip())
