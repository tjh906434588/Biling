"""风格学习（§9）：从用户编辑 diff 提炼 L2 作品风格画像，产出 style_profiles 新版本。

作用域边界：只学【作品层】偏好（句长/词汇/视角/对话比/禁忌写法）；
diff 中体现的"通用防 AI 规则"不写入 style_profiles（属于系统级 L1，见 §5.7）。
"""
import logging
import uuid

from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.schemas.style import StyleDiff, StyleLearningOutput

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是「风格学习师」。用户手动修改了 AI 生成的章节，请从这些"原文→改文"diff 中提炼作者的写作偏好。
只提炼【作品风格层】特征，输出严格的 JSON：
{"traits": {
   "sentence_length": "句式长短偏好（如'短句为主，平均8-15字'）",
   "vocabulary": "用词倾向（口语化/书面/网络词/意象词等）",
   "perspective": "视角与叙述距离",
   "dialogue_ratio": "对话 vs 描写比例偏好",
   "rhythm": "节奏与段落结构偏好",
   "example_fragment": "最能代表用户笔触的示例片段（直接摘自改文，原样引用）"},
 "avoid_list": ["用户反复改掉的写法，如'过于华丽的排比''总结性结尾句'"]}

铁律：
- 只学 diff 中【稳定、反复】出现的改动模式；一次性措辞不要写进 traits。
- 通用防 AI 规则（去总结句、少修饰词）属于系统级，不要写进这里。
- example_fragment 必须原样摘自改文，禁止自己重写。
"""


class StyleLearnerAgent(Agent[StyleLearningOutput]):
    """风格学习不流式展示给前端，直接整段取回；失败时降级为启发式摘要。"""

    task_type = "extract"
    temperature = 0.3
    mock_output = {
        "traits": {
            "sentence_length": "短句为主，平均 8-15 字，关键处单字成句",
            "vocabulary": "口语化偏冷静克制，偶用网络词制造反差",
            "perspective": "有限第三人称，紧贴主角内心",
            "dialogue_ratio": "对话偏多（约 6:4），对话承担推进与揭底",
            "rhythm": "段落短促，一个自然段一个画面",
            "example_fragment": "他攥紧那枚铜币，指节发白。",
        },
        "avoid_list": ["总结性结尾句", "过度修饰的环境描写"],
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        diffs: list[StyleDiff] = params.get("diffs") or []
        diff_text = "\n\n".join(
            f"--- diff #{d.id} ---\n【原文】{d.original}\n【改文】{d.edited}" for d in diffs
        )
        user_content = f"以下是用户对 AI 成稿的手动修改，共 {len(diffs)} 处：\n\n{diff_text}\n\n请提炼该作者的风格画像。"
        return ContextPack(
            novel_id=novel_id,
            agent="style_learner",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> StyleLearningOutput:
        return StyleLearningOutput.model_validate_json(text.strip())


async def learn_style(db: Session, novel_id: uuid.UUID, diffs: list[StyleDiff]) -> dict:
    """执行一次风格学习：调用 LLM → 写 style_profiles 新版本 → 返回结果。

    LLM 失败/无 Key 时降级：启发式从 diff 提炼示例片段与显式改掉项，不阻塞主流程。
    """
    from app.db.models import StyleProfile
    from sqlalchemy import func, select

    # 未接入模型时直接报错（不降级启发式），让用户明确知道需要先配置 AI 模型
    from app.llm.gateway import has_key_for
    from app.llm.routes import resolve_route

    route = resolve_route(db, "extract")
    if not has_key_for(route.provider, db):
        raise RuntimeError(
            f"AI 模型未接入（当前使用 {route.provider}/{route.model}，未配置 API Key）："
            f"风格学习需要调用 AI，请先到「模型」页添加模型并填入 API Key。"
        )

    agent = StyleLearnerAgent(db)
    ctx = agent.build_context(novel_id, {"diffs": diffs})

    text = ""
    try:
        async for piece in agent.run(ctx):
            text += piece
        parsed = agent.parse_output(text)
    except Exception as e:  # 任何失败：降级启发式，风格学习不阻断写作
        logger.warning("风格学习 LLM 失败，降级启发式：%s", e)
        parsed = _heuristic_fallback(diffs)

    last = db.execute(
        select(func.max(StyleProfile.version)).where(StyleProfile.novel_id == novel_id)
    ).scalar() or 0
    row = StyleProfile(
        novel_id=novel_id,
        version=last + 1,
        traits=parsed.traits.model_dump(),
        avoid_list=parsed.avoid_list,
        source_diff_ids=[d.id for d in diffs],
    )
    db.add(row)
    db.commit()
    return {
        "version": row.version,
        "traits": row.traits,
        "avoid_list": row.avoid_list,
        "source_diff_ids": row.source_diff_ids,
    }


def _heuristic_fallback(diffs: list[StyleDiff]) -> StyleLearningOutput:
    """无 LLM 时的启发式：示例片段取改文最长处，avoid_list 标记删句模式。"""
    best = max(diffs, key=lambda d: len(d.edited), default=None)
    removed = [d.original for d in diffs if d.original and not d.edited]
    return StyleLearningOutput(
        traits={
            "sentence_length": "（未能分析）",
            "vocabulary": "（未能分析）",
            "perspective": "（未能分析）",
            "dialogue_ratio": "（未能分析）",
            "rhythm": "（未能分析）",
            "example_fragment": best.edited[:120] if best else "（无示例）",
        },
        avoid_list=[f"被用户整体删除的段落：{r[:40]}…" for r in removed[:5]],
    )
