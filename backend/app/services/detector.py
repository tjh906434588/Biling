"""AI 生成检测服务（§13.5）：三层信号 + 四象限交叉，体检性质、不设硬阈值、不阻断写作。

三层信号：
1. regex 词法规则：中文 AI 成稿常见痕迹短语/句式（总结句、连接词堆叠、书面套话）。
2. density 统计指纹：句长分布/变异、标点多样性、语气词、对话占比、超长句。
3. local_heuristic：burstiness（句长起伏度）近似替代 PPL；本地无模型时 PPL 置 None 不参与打分。

输出 verdict 仅作参考展示，供作者调优 L2 风格画像与 L3 节奏指令，不拦截任何写作流程。
"""
import math
import re
from dataclasses import dataclass, field
from typing import Optional

# ---------- 1. regex 词法规则 ----------

# 总结/过渡套话（AI 高频）
_SUMMARY_PATTERNS = [
    r"总而言之",
    r"综上所述",
    r"总的来说",
    r"由此可见",
    r"换句话说",
    r"不难看出",
    r"值得一提",
    r"值得注意的是",
]
# 序列连接词堆叠
_SEQUENCE_PATTERNS = [r"首先", r"其次", r"再次", r"最后", r"与此同时", r"紧接着"]
# 高频"仿佛/似乎"类模糊副词
_VAGUE_PATTERNS = [r"仿佛", r"似乎", r"好像", r"宛如", r"犹如"]
# 过度书面套话
_STIFF_PATTERNS = [r"不禁", r"不由", r"顿时", r"旋即", r"刹那间", r"赫然", r"微微怔住"]
# 转折/因果连接词（AI 叙事高频连接）
_TRANSITION_PATTERNS = [r"但是", r"然而", r"不过", r"却", r"因此", r"所以", r"于是", r"而且", r"同时", r"尽管", r"虽然"]


def _count_patterns(text: str, patterns: list[str]) -> int:
    return sum(len(re.findall(p, text)) for p in patterns)


# ---------- 4. 句子级 AI 味句式 lint（确定性门禁，oh-story check-ai-patterns.js +
# qiaomu anti-ai-language.md 的分类思想移植；只报告命中的句子，不硬阻断）----------
# 每类 = (分类名, 正则)。命中即定位到完整句子，供 critic 逐句标出、前端展示、
# 以及写后自检的确定性依据。与 L1 提示词里的"量化自检"互补：提示词约束"不要写"，
# 这里负责"写了就指出来"。
_AI_SENTENCE_PATTERNS: list[tuple[str, re.Pattern]] = [
    # "不是 X 而是 Y" 转折强调族（qiaomu anti-ai-language 硬性门禁之首）
    ("转折强调·不是X而是Y", re.compile(r"不是[^。！？；\n]{2,14}而是")),
    # 抽象抒情堆砌（"某种说不清的……"族）
    ("抽象抒情堆砌", re.compile(
        r"(某种|一种说不清|莫名的|隐约的|难以言说的|若有若无的|挥之不去的)"
        r"[^。！？；\n]{0,10}(感觉|情绪|情愫|悸动|惆怅|哀伤|思绪|气氛|恐惧|不安|预感|东西)"
    )),
    # 空镜收尾（"他望向远方"族，oh-story 空镜类）
    ("空镜收尾·望向远方", re.compile(r"(望向|看向|眺望|望着)(远方|窗外|天际|远处|天边|虚空|前方|尽头)")),
    # 沉思式收尾（"陷入沉思"族）
    ("陷入沉思收尾", re.compile(r"(陷入(了)?(沉思|沉默|思索|回忆)|若有所思)")),
    # 金句体升华（"或许这就是……"族，每段结尾强行升华）
    ("金句体升华", re.compile(
        r"(或许|也许|大概|可能)(这|那|就|便)?(这|那)?(就是|便是|才是)?"
        r"[^。！？；\n]{0,12}(人生|命运|成长|意义|答案|一切|世界|岁月|未来)"
    )),
    # 场景切换高频时间词（此刻/一瞬间堆叠）
    ("时间词高频·此刻", re.compile(r"此刻|就在(这时|此时)|这一(刻|瞬间)|刹那间")),
    # 机械重复句（同一短句原样重复 ≥2 次，排比堆砌的极端形态）
    ("机械重复句", re.compile(r"([^。！？；\n]{3,10}，)\1")),
]

# 单类最多计入评分的命中数（防止"此刻"等高频词单类刷分，其余仍进 findings 供展示）
_LINT_SCORE_CAP_PER_CATEGORY = 3


def _sentences_with_span(text: str) -> list[tuple[str, int]]:
    """按句末标点切句并记录每个句子的起始位置（lint 定位命中句用）。"""
    out: list[tuple[str, int]] = []
    for m in re.finditer(r"[^。！？!?；;\n]+[。！？!?；;]?", text):
        s = m.group(0).strip()
        if s:
            out.append((s, m.start()))
    return out


def lint_ai_sentences(text: str) -> list[dict]:
    """确定性扫描 AI 味句式，返回 [{category, sentence, snippet}]。

    同一分类下同一句子只报一次；sentence=命中的完整句（critic 逐句标出的直接证据），
    snippet=命中的片段（前端高亮定位）。
    """
    if not text:
        return []
    sents = _sentences_with_span(text)
    findings: list[dict] = []
    for name, pat in _AI_SENTENCE_PATTERNS:
        for m in pat.finditer(text):
            pos = m.start()
            sent = ""
            for s, st in sents:
                if st <= pos < st + len(s):
                    sent = s
                    break
            if not sent:  # 命中点落在切句外（如段尾），截取命中点上下文作兜底
                sent = text[max(0, pos - 15): pos + 25].strip()
            if any(f["category"] == name and f["sentence"] == sent for f in findings):
                continue
            findings.append({"category": name, "sentence": sent, "snippet": m.group(0)})
    return findings


def format_ai_lint_report(findings: list[dict], limit: int = 8) -> str:
    """把 lint 结果压成可注入提示词/展示的文本（无命中返回"无"）。"""
    if not findings:
        return "AI 味句式检测：无命中（0 处）。"
    lines = [f"AI 味句式检测（确定性正则，命中 {len(findings)} 处，逐句标出）："]
    for f in findings[:limit]:
        lines.append(f"- [{f['category']}]「{f['sentence']}」")
    if len(findings) > limit:
        lines.append(f"… 其余 {len(findings) - limit} 处略，请一并处理同类句子。")
    return "\n".join(lines)


# ---------- 2. density 统计指纹 ----------


@dataclass
class DensityStats:
    sentences: int = 0
    avg_sentence_len: float = 0.0
    std_sentence_len: float = 0.0  # 句长标准差（burstiness 代理）
    short_ratio: float = 0.0  # 极短句（<=6 字）比例
    long_ratio: float = 0.0  # 超长句（>=60 字）比例
    commas_per_sentence: float = 0.0
    transition_density: float = 0.0  # 转折/因果连接词每千字
    exclamation_ratio: float = 0.0  # 感叹/问号占句号类比例
    dialogue_ratio: float = 0.0  # 引号内字符占比
    stopword_density: float = 0.0  # 语气词每千字


_SENT_SPLIT = re.compile(r"[。！？!?；;\n]+")
_QUOTE = re.compile(r"[“”\"'「」]")


def density_stats(text: str) -> DensityStats:
    sents = [s.strip() for s in _SENT_SPLIT.split(text) if s.strip()]
    n = len(sents)
    if n == 0:
        return DensityStats()

    lens = [len(s) for s in sents]
    avg = sum(lens) / n
    var = sum((x - avg) ** 2 for x in lens) / n
    std = math.sqrt(var)
    total_chars = len(text) or 1

    stats = DensityStats(
        sentences=n,
        avg_sentence_len=round(avg, 1),
        std_sentence_len=round(std, 1),
        short_ratio=round(sum(1 for x in lens if x <= 6) / n, 3),
        long_ratio=round(sum(1 for x in lens if x >= 60) / n, 3),
        commas_per_sentence=round(text.count("，") / n, 2),
        transition_density=round(_count_patterns(text, _TRANSITION_PATTERNS) * 1000 / total_chars, 2),
        exclamation_ratio=round((text.count("！") + text.count("？")) / max(n, 1), 2),
        dialogue_ratio=round(min(_QUOTE.findall(text).__len__() * 2.0 / total_chars, 1.0), 3),
        stopword_density=round(_count_patterns(text, [r"啊", r"呢", r"吧", r"吗", r"呀"]) * 1000 / total_chars, 2),
    )
    return stats


# ---------- 3. heuristic 综合评分 ----------


@dataclass
class DetectionResult:
    regex_hits: dict = field(default_factory=dict)  # 规则类别 → 命中次数
    density: Optional[dict] = None
    heuristic_score: int = 0  # 0-100，AI 可能性
    burstiness: Optional[float] = None  # 句长变异系数
    ppl: Optional[float] = None  # 本地模型未装时为 None（不参与打分）
    verdict: str = "unknown"  # likely_human|mixed|likely_ai
    signals: list[str] = field(default_factory=list)  # 供前端展示的信号说明
    # 句子级 AI 味句式 lint 结果（确定性正则）：[{category, sentence, snippet}]
    sentence_findings: list = field(default_factory=list)
    note: str = "体检参考，不设硬阈值、不阻断写作；若分数偏高请优先调优 L2 风格画像与 L3 节奏指令，而非针对阈值洗稿。"


def _score_from_stats(stats: DensityStats) -> tuple[int, list[str]]:
    """统计指纹 → AI 倾向分（0-100）+ 信号说明。经验加权，无硬阈值。"""
    score = 0
    signals: list[str] = []

    # 句长过平（std 过低）→ 流水账感，AI 常见
    if stats.sentences >= 10:
        cv = stats.std_sentence_len / max(stats.avg_sentence_len, 1)
        if cv < 0.45:
            score += 22
            signals.append(f"句长过于平均（变异系数 {cv:.2f} < 0.45），缺乏人类写作的起伏")
        elif cv < 0.7:
            score += 8
        if stats.short_ratio < 0.12 and stats.long_ratio < 0.05:
            score += 12
            signals.append("极短句与超长句都偏少，句子形态单一")

    # 超长句堆叠 → 书面流水
    if stats.long_ratio > 0.15:
        score += 10
        signals.append(f"超长句占比 {stats.long_ratio:.0%} 偏高")

    # 连接词密度（转折/因果）
    if stats.transition_density > 6:
        score += 15
        signals.append(f"转折/因果连接词密度 {stats.transition_density}/千字 偏高，叙事'扣链子'痕迹重")
    elif stats.transition_density > 3.5:
        score += 6

    # 逗号密度（AI 长句内逗号多）
    if stats.commas_per_sentence > 3.5:
        score += 8
    # 感叹/问号过少 → 缺乏语气起伏
    if stats.exclamation_ratio < 0.05 and stats.sentences >= 10:
        score += 6
        signals.append("感叹/疑问语气偏少，情绪起伏弱")

    return min(score, 55), signals


def detect(text: str) -> DetectionResult:
    """三层信号交叉 → DetectionResult（不抛异常，任何异常降级为 unknown）。"""
    result = DetectionResult()
    try:
        text = text or ""
        if not text.strip():
            result.note = "空文本未检测"
            return result

        # 1. regex 层
        regex_hits = {
            "总结套话": _count_patterns(text, _SUMMARY_PATTERNS),
            "序列连接词": _count_patterns(text, _SEQUENCE_PATTERNS),
            "模糊副词(仿佛/似乎)": _count_patterns(text, _VAGUE_PATTERNS),
            "过度书面套话": _count_patterns(text, _STIFF_PATTERNS),
        }
        # 句子级 AI 味句式 lint：确定性正则逐句扫描（结果供 critic/前端逐句定位）
        findings = lint_ai_sentences(text)
        result.sentence_findings = findings
        lint_by_cat: dict[str, int] = {}
        for f in findings:
            lint_by_cat[f["category"]] = lint_by_cat.get(f["category"], 0) + 1
        regex_hits["AI味句式"] = sum(lint_by_cat.values())
        result.regex_hits = regex_hits
        total_regex = sum(regex_hits.values())

        # 2. density 层
        stats = density_stats(text)
        result.density = {
            "sentences": stats.sentences,
            "avg_sentence_len": stats.avg_sentence_len,
            "std_sentence_len": stats.std_sentence_len,
            "short_ratio": stats.short_ratio,
            "long_ratio": stats.long_ratio,
            "commas_per_sentence": stats.commas_per_sentence,
            "transition_density": stats.transition_density,
            "exclamation_ratio": stats.exclamation_ratio,
            "dialogue_ratio": stats.dialogue_ratio,
            "stopword_density": stats.stopword_density,
        }
        if stats.avg_sentence_len > 0:
            result.burstiness = round(stats.std_sentence_len / stats.avg_sentence_len, 3)

        # 3. heuristic 层（regex + density 交叉）
        score, signals = _score_from_stats(stats)
        if total_regex >= 6:
            score += 18
            signals.append(f"词法痕迹命中 {total_regex} 处（总结/序列/套话类），偏模板化")
        elif total_regex >= 3:
            score += 8
        elif total_regex >= 1:
            score += 3

        # 4. 句子级 AI 味句式 lint：单类命中 ≥3 处或多类合计 ≥4 处即显著降分
        # 单类最多计 _LINT_SCORE_CAP_PER_CATEGORY 处，防"此刻"等高频词单类刷分
        lint_total = 0
        for cat_count in lint_by_cat.values():
            lint_total += min(cat_count, _LINT_SCORE_CAP_PER_CATEGORY)
        if lint_total >= 4:
            score += 16
            top_cats = "、".join(
                f"{k}×{v}" for k, v in sorted(lint_by_cat.items(), key=lambda kv: -kv[1])[:3]
            )
            signals.append(f"AI 味句式命中 {sum(lint_by_cat.values())} 处（{top_cats}），句子清单见 sentence_findings")
        elif lint_total >= 2:
            score += 8
            signals.append("检出少量 AI 味句式，建议对照 L1 自检清单改写")

        result.heuristic_score = min(score, 100)
        result.signals = signals
        result.verdict = (
            "likely_ai" if score >= 62 else "mixed" if score >= 40 else "likely_human"
        )
    except Exception:  # 检测任何异常都不影响主流程
        result.note = "检测过程异常，已降级为 unknown（不阻断写作）"
    return result
