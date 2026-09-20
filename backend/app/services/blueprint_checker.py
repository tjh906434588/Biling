"""蓝图核对服务：导入大纲文档 vs 生成蓝图，逐节比对找"文档有、蓝图没/不全"。

流程：
1. 确定性切分文档章节（按标题行）；
2. 优先 LLM 核对（import_checker 角色，语义级判定 full/partial/missing）；
3. LLM 不可用/失败时回退确定性扫描（章节关键词覆盖度估算），结果标注 source=deterministic。
"""
import json
import logging
import re
import uuid

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# 章节标题行识别：阿拉伯数字+顿点/括号、中文数字+顿号、第X卷/部分、【标题】
_HEADING_RE = re.compile(
    r"^\s*(?:"
    r"(?:\d{1,3}[、.．:：)）])"                     # 1. / 1、 / 1） / 1：
    r"|(?:[一二三四五六七八九十]{1,3}[、.．:：)）])"   # 一、 / 二.
    r"|(?:第[一二三四五六七八九十百]+[部分卷章篇节])"   # 第X卷 / 第X部分
    r"|(?:【[^】]{1,30}】)"                        # 【标题】
    r")"
)
_CJK = re.compile(r"[^\u4e00-\u9fff]")
_SPLIT = re.compile(r"[^\u4e00-\u9fff0-9]+")

MAX_SECTION_BODY = 800  # 每个章节喂给 LLM 的正文上限
MAX_DOC_TEXT = 16_000  # 喂给 LLM 的文档总长上限
MAX_BLUEPRINT_TEXT = 14_000  # 喂给 LLM 的蓝图文本上限


# ---------- 文档章节切分 ----------


def split_sections(text: str) -> list[dict]:
    """按标题行把导入文档切成 [{heading, body}]；标题前的内容归入「开头」。"""
    sections: list[dict] = []
    cur: dict | None = None
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if len(s) <= 60 and _HEADING_RE.match(line):
            if cur is not None:
                sections.append(cur)
            cur = {"heading": s, "body": []}
        else:
            if cur is None:
                cur = {"heading": "开头", "body": []}
            cur["body"].append(s)
    if cur is not None:
        sections.append(cur)
    return [
        {"heading": sec["heading"], "body": "\n".join(sec["body"]).strip()}
        for sec in sections
        if sec["body"]
    ]


def serialize_blueprint(content: dict) -> str:
    """把蓝图 content 展开为便于比对的纯文本。"""
    try:
        return json.dumps(content, ensure_ascii=False, indent=1)
    except (TypeError, ValueError):
        return str(content)


# ---------- 确定性回退扫描 ----------


def _bigrams(text: str) -> set[str]:
    cjk = _CJK.sub("", text)
    return {cjk[i : i + 2] for i in range(len(cjk) - 1)}


def _deterministic_check(sections: list[dict], blueprint_text: str) -> list[dict]:
    """启发式：按章节中文双字词与蓝图文本的覆盖度粗判，仅供 LLM 不可用时的参考。"""
    bp_grams = _bigrams(blueprint_text)
    items: list[dict] = []
    for sec in sections:
        body = sec["body"]
        grams = _bigrams(body)
        if not grams:
            continue
        hit = len(grams & bp_grams) / len(grams)
        coverage = "full" if hit >= 0.5 else ("partial" if hit >= 0.25 else "missing")
        excerpt = " ".join(body.split())[:150]
        items.append({
            "section": sec["heading"],
            "coverage": coverage,
            "doc_excerpt": excerpt,
            "blueprint_field": "待人工确认",
            "note": f"关键词覆盖度 {int(hit * 100)}%（启发式估算，建议人工核对）",
        })
    return items


# ---------- LLM 核对 ----------


async def _llm_check(db: Session, novel_id: uuid.UUID, sections: list[dict], blueprint_text: str) -> list[dict]:
    from app.agents.registry import get_agent

    doc_text = "\n\n".join(
        f"【{sec['heading']}】\n{sec['body'][:MAX_SECTION_BODY]}" for sec in sections
    )
    if len(doc_text) > MAX_DOC_TEXT:
        doc_text = doc_text[:MAX_DOC_TEXT] + "\n…（文档过长，已截断到前部）"

    agent = get_agent(db, "import_checker")
    ctx = agent.build_context(novel_id, {
        "doc_text": doc_text,
        "blueprint_text": blueprint_text[:MAX_BLUEPRINT_TEXT],
    })
    last_err: Exception | None = None
    # LLM 偶发输出格式不稳定，失败重试一次，避免整次语义核对回退为关键词扫描
    for attempt in range(2):
        try:
            out = ""
            async for piece in agent.run(ctx):
                out += piece
            parsed = agent.parse_output(out)
            return [item.model_dump() for item in parsed.missing]
        except Exception as e:
            last_err = e
            logger.warning("agent=import_checker 第 %d 次语义核对失败：%s（重试一次）", attempt + 1, e)
    if last_err is None:
        raise RuntimeError("import_checker 语义核对失败")
    raise last_err


# ---------- 对外入口 ----------


async def run_blueprint_check(db: Session, novel_id: uuid.UUID, blueprint, source_doc: str) -> dict:
    """执行一次校验比对：文档 vs 蓝图 content，返回 {total_sections, source, missing, note}。

    blueprint：Blueprint ORM 行（读 .content 字典）。
    """
    sections = split_sections(source_doc)
    if not sections:
        return {
            "total_sections": 0,
            "source": "none",
            "missing": [],
            "note": "未能从文档中识别出章节结构，无法比对。",
        }
    blueprint_text = serialize_blueprint(blueprint.content or {})
    try:
        items = await _llm_check(db, novel_id, sections, blueprint_text)
        return {
            "total_sections": len(sections),
            "source": "llm",
            "missing": items,
            "note": "",
        }
    except Exception:
        logger.exception("agent=import_checker 语义核对失败，回退确定性扫描")
        items = _deterministic_check(sections, blueprint_text)
        return {
            "total_sections": len(sections),
            "source": "deterministic",
            "missing": items,
            "note": "语义核对暂不可用，以下为关键词覆盖度扫描结果，仅供参考。",
        }
