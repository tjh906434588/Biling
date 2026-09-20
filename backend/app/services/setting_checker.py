"""设定确定性核对（评价师用）：从蓝图/设定库抽出「共现组」，检查本章正文是否漏写组内成员。

## 为什么需要这一层
面板固定字段这类规则是「可枚举、可字面匹配」的硬约束，但评价师原本只做**整体印象打分**：
蓝图动辄 7000+ 字、几十上百条规则，LLM 通读一遍只能抽查自己注意到的几条
→ 漏检是常态、抓到是运气（第 2 章漏写「兴趣爱好」没报，第 3 章同样的规则却报了）。
这一层用确定性匹配兜底，把命中的缺失作为「必须回应的待确认项」交给评价师。

## 核心设计：共现约束
把「天赋清单+兴趣爱好+适配推荐」视为一组：
- 组内**至少一个**成员在正文出现 → 本章确实写到了这个概念域，**触发核对**；
- 此时组内**其余没出现的**成员才算漏写；
- 组内一个都没出现（本章压根没写系统面板）→ **不触发**，避免误报。

## 噪声控制（宁可少报，不可乱报）
① 只认 `+` `＋` `/` `／` 这类"清单式"分隔符，不认「、」，避免把散文排比当规则；
② **术语边界修正**：中文无词边界，靠"全书语料出现次数"把误吞的前缀切掉
   （`容为天赋清单` → `天赋清单`）；
③ 组内每个术语必须在全书语料中出现 ≥2 次；
④ **必现锚点**：组前面必须出现「固定内容/必须/包含/包括/组成/要素/字段/必备」等字样，
   否则判定为"备选枚举"（如 良好/优秀/卓越/天才 是等级档位，不是每章都要凑齐），直接丢弃；
⑤ 支持蓝图里手写 `setting_checks` 显式清单，有它则以它为准（完全免抽取）。
"""
import logging
import re
import uuid
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ① 清单式分隔符：刻意不含「、」
_SEP_CLASS = r"[+＋/／]"
_TERM = r"[\u4e00-\u9fff]{2,6}"
_GROUP_RE = re.compile(rf"{_TERM}(?:\s*{_SEP_CLASS}\s*{_TERM}){{1,5}}")
_SPLIT_RE = re.compile(rf"\s*{_SEP_CLASS}\s*")

# ④ 必现锚点：命中其一才认为这一组是"必须凑齐"，否则视为备选枚举
_REQUIRE_MARKERS = (
    "固定内容", "固定项目", "必须", "应包含", "需包含", "包含", "包括",
    "组成", "要素", "字段", "必备", "齐全", "缺一不可", "三项", "三项均",
)
_CONTEXT_BEFORE = 14  # 往前看多少字找锚点

_STOPWORDS = {
    "可以", "不要", "不能", "需要", "可能", "就是", "还是", "以及", "并且",
    "或者", "但是", "因为", "所以", "如果", "已经", "这个", "那个", "什么", "怎么",
    "如何", "是否", "有无", "多少", "大小", "上下", "前后", "左右", "好坏",
}

MIN_CORPUS_HITS = 2


def _trim_term(term: str, corpus: str) -> Optional[str]:
    """②术语边界修正：从最长到最短逐级砍掉左侧字符，取第一个在全书语料里够常见的。

    「容为天赋清单」→ 依次试「为天赋清单」「天赋清单」→ 后者在语料里高频，命中。
    """
    for i in range(len(term) - 1):  # 至少保留 2 字，故最多砍到剩 2
        cand = term[i:]
        if len(cand) < 2:
            break
        if corpus.count(cand) >= MIN_CORPUS_HITS:
            return cand
    return None


def _extract_groups(blob: str, corpus: str) -> list[list[str]]:
    """从一个文本块里抽出「必现清单」组。"""
    groups: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()
    if not blob:
        return groups
    for m in _GROUP_RE.finditer(blob):
        raw_terms = [t.strip() for t in _SPLIT_RE.split(m.group(0)) if t.strip()]
        if not (2 <= len(raw_terms) <= 6):
            continue
        # ④ 必现锚点
        #    注意：中文术语的前边界可能会被上文的字吞掉（「固定内容」的「容」被算进组内），
        #    所以锚点窗口要往右多吃几个字，否则「固定内容」会被切成「固定内」+「容…」而漏判。
        ctx = blob[max(0, m.start() - _CONTEXT_BEFORE) : m.start() + 12]
        if not any(k in ctx for k in _REQUIRE_MARKERS):
            continue
        terms: list[str] = []
        for t in raw_terms:
            fixed = _trim_term(t, corpus)
            if fixed is None or fixed in _STOPWORDS:
                terms = []
                break
            terms.append(fixed)
        if len(terms) != len(raw_terms) or len(set(terms)) != len(terms):
            continue
        key = tuple(terms)
        if key in seen:
            continue
        seen.add(key)
        groups.append(terms)
    return groups


def _corpus_text(content: Optional[dict], settings) -> str:
    """把蓝图 content + 设定条目拼成语料，用于术语边界修正与常见度判断。"""
    parts: list[str] = []
    if content:
        for wr in (content.get("world_rules") or []):
            if isinstance(wr, dict):
                parts.append(str(wr.get("name", "")))
                parts.append(str(wr.get("detail", "")))
                parts.extend(str(c) for c in (wr.get("constraints") or []))
        for key in ("theme", "core_conflict", "logline", "notes"):
            if content.get(key):
                parts.append(str(content[key]))
    for s in settings:
        parts.append(str(s.name))
        parts.append(str(s.description or ""))
        st = s.structured or {}
        for k in ("constitution_text", "dynamic_text"):
            if st.get(k):
                parts.append(str(st[k]))
    return "\n".join(parts)


def extract_checklist(
    blueprint_content: Optional[dict],
    settings: list,
) -> list[tuple[str, list[str], str]]:
    """抽出全部「必现清单」（不判断正文），供写前注入使用。

    返回 [(规则名, 术语列表, 来源)]。共现判断（本章是否涉及该概念域）不在这里做，
    因为写之前还没有正文——那一步属于 :func:`check_chapter`。
    """
    corpus = _corpus_text(blueprint_content, settings)
    out: list[tuple[str, list[str], str]] = []

    # ⑤ 显式清单优先：蓝图 content.setting_checks 免抽取、零噪声
    for item in ((blueprint_content or {}).get("setting_checks") or []):
        if not isinstance(item, dict):
            continue
        terms = [str(t) for t in (item.get("terms") or []) if str(t).strip()]
        if len(terms) >= 2:
            out.append((str(item.get("name") or "显式核对清单"), terms, "explicit"))

    # 自动抽取：蓝图 world_rules（detail 与 constraints 都要扫，硬约束常写在 constraints 里）
    for wr in ((blueprint_content or {}).get("world_rules") or []):
        if not isinstance(wr, dict):
            continue
        name = str(wr.get("name") or "未命名规则")
        blob = " ".join(
            [str(wr.get("detail") or "")] + [str(c) for c in (wr.get("constraints") or [])]
        )
        for g in _extract_groups(blob, corpus):
            out.append((name, g, "auto"))

    # 自动抽取：设定条目
    for s in settings:
        st = s.structured or {}
        blob = " ".join(
            [str(s.description or "")]
            + [str(st.get(k) or "") for k in ("constitution_text", "dynamic_text")]
        )
        for g in _extract_groups(blob, corpus):
            out.append((str(s.name), g, "auto"))
    return out


def check_chapter(
    db: Session,
    novel_id: uuid.UUID,
    chapter_text: str,
    blueprint_content: Optional[dict],
    settings: list,
) -> list[dict]:
    """确定性核对本章正文，返回缺失项列表。

    每项形如 {"rule": 规则名, "group": [...], "present": [...], "missing": [...], "source": ...}。
    """
    text = chapter_text or ""

    # 自动抽取的组可能抽歪（中文无词边界），要求每个术语在全书语料里够常见才采信
    corpus = _corpus_text(blueprint_content, settings)
    candidates = [
        (name, terms, src)
        for name, terms, src in extract_checklist(blueprint_content, settings)
        if not (src == "auto" and any(corpus.count(t) < MIN_CORPUS_HITS for t in terms))
    ]

    items: list[dict] = []
    emitted: set[tuple[str, ...]] = set()
    for rule_name, terms, source in candidates:
        key = tuple(terms)
        if key in emitted:
            continue
        hits = [t for t in terms if t in text]
        # 共现约束：一个都没出现 → 本章不涉及这个概念域，不算漏
        if not hits:
            continue
        missing = [t for t in terms if t not in text]
        if not missing:
            continue
        emitted.add(key)
        items.append({
            "rule": rule_name,
            "group": terms,
            "present": hits,
            "missing": missing,
            "source": source,
        })
    return items


def format_required_list(checklist) -> str:
    """写前注入用：把「必现清单」压成明确的硬约束条款，避免它淹没在蓝图长句里。

    与 :func:`format_for_prompt` 的区别：后者是写后核对结果（含缺失），这是写前清单（不含）。
    之所以需要单独一份——第 2/3 章漏写「兴趣爱好」的根因就是这条规则埋在 288 字
    的 detail 长句中（位于蓝图全文 81% 处），模型注意不到。
    """
    if not checklist:
        return ""
    lines = []
    seen: set[tuple[str, ...]] = set()
    for name, terms, _src in checklist:
        key = tuple(terms)
        if key in seen:
            continue
        seen.add(key)
        lines.append(
            f"- 《{name}》：[{' + '.join(terms)}] 是一组**必须同时出现**的内容。"
            f"本章只要写到其中任意一项，就必须把剩余各项一并写到；不要挑着写。"
        )
    return "\n".join(lines)


def format_for_prompt(items: list[dict]) -> str:
    """把核对结果格式化成注入评价师 prompt 的文本。"""
    if not items:
        return "（确定性核对未发现清单项缺失）"
    lines = []
    for it in items:
        lines.append(
            f"- 规则《{it['rule']}》要求一组内容同时出现：[{' + '.join(it['group'])}]。"
            f"本章正文出现了 {len(it['present'])}/{len(it['group'])} 项"
            f"（已出现：{'、'.join(it['present'])}），**缺失：{'、'.join(it['missing'])}**。"
        )
    return "\n".join(lines)
