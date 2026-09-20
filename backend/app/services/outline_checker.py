"""大纲骨架校验服务：导入大纲的四件套骨架语义校验（生成前体检）。

流程：
1. 复用 blueprint_checker.split_sections 切分文档标题节；
2. 优先 LLM 语义校验（outline_checker 角色，判断内容是否真实覆盖）；
3. LLM 不可用/失败时回退确定性关键词扫描，结果标注 source=deterministic。
"""
import logging
import re

from sqlalchemy.orm import Session

from app.services.blueprint_checker import split_sections

logger = logging.getLogger(__name__)

MAX_DOC_TEXT = 16_000  # 喂给 LLM 的文档总长上限

# 确定性回退：与前端 OUTLINE_CHECKS 对齐的关键词模式（LLM 不可用时的初筛）
_PATTERNS: dict[str, list[str]] = {
    "scale": [
        r"\d[\d.,]*\s*万\s*字",  # 240万字 / 240万 字
        r"[一二三四五六七八九十百千零]+\s*万\s*字",  # 二百四十万字
        r"总字数|总体量|总章数|章节数|单章字数|单章标准|字/章|字每章",
        r"\d+\s*章",  # 800章 / 120章
    ],
    "volumes": [
        r"【\s*第?\s*\d+\s*[-–—\u2011~～至]\s*\d+\s*章?",  # 章节范围【第1-85章】/【1-85章】
        r"第[一二三四五六七八九十百千零\d]+[卷部][:：]?\s*【",  # 第X卷【章节范围】
        r"卷名\s*[:：]",  # 卷名：
        r"本卷重点|本卷剧情|本卷核心|本卷概要|本卷目标",  # 卷级重点/剧情标注
        r"第[一二三四五六七八九十百千零\d]+章\s*[:：]",  # 第一章：标题（章节列表）
    ],
    "characters": [
        r"主角|配角|人物|角色|人设|人物弧|弧光|姓名|性格|成长线|成长弧线|心性",
    ],
    "plot": [
        r"剧情|故事|主线|支线|剧情线|故事线|走向|梗概|核心逻辑|滚雪球",
    ],
    # 选填建议模块：爽点/节奏规划、差异化/卖点定位（模块通用，内容因书而异）
    "pacing": [
        r"爽点|爽感|钩子|糖点|期待感|节奏|高潮|情绪点|爆点",
    ],
    "differentiators": [
        r"差异化|卖点|对标|参考作品|独特设定|不撞|创新点|立意|平台流量",
    ],
}

_HINTS: dict[str, str] = {
    "scale": "未检测到全书体量规划，补充总字数/总章数/单章字数，如「240万字 · 800章 · 3000字/章」",
    "volumes": "未检测到分卷/章节结构，补充卷名 + 章节范围（如【第1-85章】）+ 本卷重点/剧情；仅有「第X卷：字数｜章数」的数据表不算分卷结构",
    "characters": "未检测到核心人物设定，补充主角（至少）的姓名/性格/起点→终点/成长转折，配角有则一并列出",
    "plot": "未检测到主线/支线，补充主线剧情走向或长效支线，如「核心剧情走向：…」",
    "pacing": "未检测到爽点/节奏规划（选填建议），可按前期/中期/后期补充，如「前期：新手成长、吊打行业乱象」",
    "differentiators": "未检测到差异化/卖点定位（选填建议），可补充对标作品、独特设定、立意卖点，如「对标《工业之心》；系统认知绑定、办学创新」",
}

_OPTIONAL_IDS = {"pacing", "differentiators"}


def _deterministic_check(text: str) -> dict:
    modules = []
    for mid, pats in _PATTERNS.items():
        ok = any(re.search(p, text) for p in pats)
        modules.append({
            "id": mid,
            "ok": ok,
            "reason": "已检测到相关内容" if ok else _HINTS[mid],
            "optional": mid in _OPTIONAL_IDS,
        })
    return {"source": "deterministic", "modules": modules}


async def run_outline_check(db: Session, novel_id, text: str) -> dict:
    """LLM 语义校验六个骨架模块；失败回退关键词扫描。返回 {source, modules:[{id, ok, reason, optional}]}。"""
    from app.agents.registry import get_agent

    sections = split_sections(text)
    doc_text = "\n\n".join(f"【{s['heading']}】\n{s['body']}" for s in sections) or text
    if len(doc_text) > MAX_DOC_TEXT:
        doc_text = doc_text[:MAX_DOC_TEXT] + "\n…（文档过长，仅评审前部）"
    try:
        agent = get_agent(db, "outline_checker")
        ctx = agent.build_context(novel_id, {"doc_text": doc_text})
        out = ""
        async for piece in agent.run(ctx):
            out += piece
        parsed = agent.parse_output(out)
        return {"source": "llm", "modules": [m.model_dump() for m in parsed.modules]}
    except Exception:
        logger.exception("agent=outline_checker 语义校验失败，回退关键词扫描")
        return _deterministic_check(text)
