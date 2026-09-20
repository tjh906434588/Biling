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

        result.heuristic_score = min(score, 100)
        result.signals = signals
        result.verdict = (
            "likely_ai" if score >= 62 else "mixed" if score >= 40 else "likely_human"
        )
    except Exception:  # 检测任何异常都不影响主流程
        result.note = "检测过程异常，已降级为 unknown（不阻断写作）"
    return result
