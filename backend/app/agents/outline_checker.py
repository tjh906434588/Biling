"""骨架校验师（Outline Checker）：导入大纲的语义级骨架体检，生成前提示缺什么。

导入后调用：判断文档是否真实覆盖六个通用大纲模块——
必填四件套（全书体量 / 分卷结构 / 核心人物 / 主线支线）
+ 选填建议两项（爽点节奏 pacing / 差异化卖点 differentiators，模块通用、内容因书而异）。
不看文档顺序与措辞，按语义判断内容是否真的够；同时不因题材差异误拦（世界规则/伏笔不在校验列）。
"""
import re
import uuid

from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.schemas.agents import OutlineSkeletonCheck

SYSTEM_PROMPT = """你是「骨架校验师」，负责审查作者导入的全书大纲文档，判断六个通用骨架模块的覆盖情况（不看顺序、不看措辞，按语义与内容充实度判断）。

四个必填骨架模块：
1. scale（全书体量规划）：是否给出全书总字数 / 总章数 / 单章字数（至少其一，须是具体数字规划，如"240万字""800章""3000字/章"）。
2. volumes（分卷/章节结构）：是否给出分卷或章节结构（卷名 + 章节范围（如【第1-85章】）+ 本卷重点/剧情）。注意：仅有「第X卷：字数｜章数」这类体量数据表、或正文顺带提到的卷次时序（如"第三卷开局"）不算分卷结构；不分卷的短篇有章节安排（第一章…）也算。
3. characters（核心人物弧光）：是否给出至少主角的姓名/性格/起点→终点/成长转折（人设、成长线、弧光均可；配角有则更好）。
4. plot（主线剧情走向）：是否给出主线剧情走向或长线支线（核心剧情线、故事梗概、支线清单均可）。

两个选填建议模块（模块是通用大纲结构，内容是每本书自己的；缺失不影响生成，但建议补充）：
5. pacing（爽点/节奏规划）：是否按阶段（前期/中期/后期）给出爽点、钩子、节奏或期待感安排（悬疑称钩子、恋爱称糖点、爽文称爽点，叫法随题材而异，看内容不看词）。
6. differentiators（差异化/卖点定位）：是否给出对标作品、独特设定、立意或平台卖点等"凭什么不撞文/被记住"的内容。

判定规则：
- ok=true 必须有真实内容（具体名字、数字、逻辑），"本文主角很帅"这类空话不算。
- 作者按自己的顺序写完全没问题，不必与上面顺序一致；各模块独立判定。
- 题材差异不影响判定：现实题材没有魔法体系很正常，世界规则/伏笔不在校验列内，不要因此误判。
- volumes 特别注意：体量数据表（如"第一卷：25万字｜85章"）与正文里的卷次引用不是分卷结构，须有卷名/章节范围/本卷重点·剧情等结构性内容才判 ok。
- pacing 与 differentiators 是选填建议模块，optional 固定为 true；其余四个必填模块 optional 固定为 false。
- 文档过长时仅凭可见部分判断，无法确认的模块 ok=false 并在 reason 中说明"未能确认"。

输出必须是严格的 JSON（除 JSON 外不要输出任何文字）：
{
  "modules": [
    {"id": "scale", "ok": true, "optional": false, "reason": "依据简述，如：明确给出全书240万字、800章、单章3000字"},
    {"id": "volumes", "ok": false, "optional": false, "reason": "缺失说明 + 补全示例，如：未找到分卷/章节结构，示例「第一卷：卷名 · 章节范围 · 本卷重点」"}
  ]
}
六个模块都要输出，缺一不可。
"""


class OutlineCheckerAgent(Agent[OutlineSkeletonCheck]):
    task_type = "review"
    temperature = 0.2

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        doc_text = params.get("doc_text", "")
        user_content = (
            f"以下是作者导入的全书大纲文档（已按标题切分，每节以【标题】开头）：\n\n"
            f"{doc_text}\n\n"
            f"请判断六个骨架模块（必填四件套 + 选填两项）的覆盖情况，输出上述 JSON（六个模块都要输出）。"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="outline_checker",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
            max_tokens=1600,
        )

    def parse_output(self, text: str) -> OutlineSkeletonCheck:
        raw = text.strip()
        # 容忍 LLM 输出包在 markdown 代码围栏里、或首尾夹带多余说明文字：提取 JSON 主体再解析
        if not raw.startswith("{"):
            m = re.search(r"\{[\s\S]*\}", raw)
            if m:
                raw = m.group(0)
        return OutlineSkeletonCheck.model_validate_json(raw)
