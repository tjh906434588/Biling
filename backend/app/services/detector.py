"""AI 生成检测服务：三层信号 + 四象限交叉，体检性质、不设硬阈值、不阻断写作。

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
    """统计一组正则模式在文本中的总命中次数（regex 词法规则层用）。"""
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
    # 破折号后置解说：写完 X，破折号后再把 X 解释一遍（破折号尾段 ≥8 字即候选；
    # AI 最爱用"——"做插入解说，把读者当傻子。误报（真正急转/递进）由评价师按现有约定回应）
    ("破折号·后置解说", re.compile(r"——[^。！？；\n]{8,}")),
    # 比喻·像字套壳：得/地像、像……一样/似的、宛如/犹如/恰似、裸"像X。"（句尾收束的
    # 空泛喻体）等无新信息的套壳比喻。排除 好像/就像/不像/如同 等非比喻用法，以及
    # 像样/像话/像素/像模像样 等"像"作词素的名词用法；具体且延续到下一句的好比喻
    # （像X，后续有落点）不在此列，由评价师按现有约定回应
    ("比喻·像字套壳", re.compile(
        r"(得|地)像[^，。！？；\n]{1,12}"
        r"|像[^，。！？；\n]{2,10}(一样|似的|般)"
        r"|(宛如|犹如|恰似|恍若)[^，。！？；\n]{1,12}"
        r"|(?<!好|就|犹|不)像(?!样|话|素|模)[^，。！？；\n]{3,14}[。！？]"
    )),
    # 甩尾句式：固定"动作+顿+否定收尾"三段式（张了张嘴，没说话 / 嘴唇动了动，没出声）。
    # 已收紧：出现一次即报，且覆盖更全的句式族——冻结固定形（张嘴/动嘴/攥拳）、
    # 身体部位+重复形+否定尾（手攥了攥，没再开口 / 肩膀抖了抖，话到嘴边…）、
    # 逗号+欲言又止短收尾（，一句话接不上来 / 话到嘴边又咽回去）、试了N次/回+否定（试了三次，没改）。
    # 注意：不做独立的"，没X"裸匹配（会把"把烟掐灭，没说话"这类正常叙事误伤），
    # 只匹配"顿"之后紧跟否定/欲言又止的完整句式
    ("甩尾句式·动作顿否", re.compile(
        r"(张了张嘴|张了张口|张张嘴|张张口|嘴唇动了动|嘴动了动|拳头攥紧|攥紧拳头)"
        r"|(肩膀|拳头|眉头|嘴唇|喉头|手|肩|拳|眉|唇|眼|喉|头)(动了动|攥了攥|抖了抖|颤了颤|张了张|哽了哽|摇了摇)[，,](没|话|半句|一个|说不|接不)"
        r"|，(一句话|半句话|话)?(接不上|接不下去|说不出来|说不出话|答不上来|没说出来|没说出口|咽了回去)"
        r"|话到嘴边[^，。！？；\n]{0,6}(咽|吞|收)"
        r"|了[一二三四五六七八九十百千0-9]+(次|回|遍|趟)[，,](没|仍|还是|依然|始终)"
    )),
    # 解说式旁白：解释刚写完的内容，把读者当傻子（说白了/也就是说/可想而知 等框架词）
    ("解说式旁白", re.compile(
        r"说白了|说白了就是|换句话说|也就是说|也就是|简而言之"
        r"|意味着|意思是说|意思就是|可想而知|不用想也知道|傻子都能看出来|傻子都看得出来|明摆着"
        r"|说到底|归根结底|归根到底|归根结蒂|说穿了|往深了说|换句话讲"
    )),
    # 解说式旁白·心理计算：作者替读者做算术/下经济结论（"三百五。他算了算，够交房租和吃饭"），
    # 数字给读者即可，结论让读者自己得；命中即候选，评价师逐句确认或说明误报
    ("解说式旁白·心理计算", re.compile(
        r"(算了算|盘算|心算|粗粗一算|粗略一算|心里一算|心里算了笔账)"
        r"[^。！？；\n]{0,14}(够|差|剩|攒|勉强|正好|刚够|不够|够用|省下|还差|省出)"
    )),
    # 注水·无信息等待：干等一件与剧情无关的事（"蹲了十分钟，等太阳把钥匙孔照亮"这类
    # 「时间+等待+环境」的干等）。命中即候选，评价师确认等待是否有剧情落点：
    # 没落点 → 删除；有落点（等的是会改变局面的东西、等待带出人物状态）→ 说明不适用
    ("注水·无信息等待", re.compile(
        r"(蹲|站|坐|靠|趴|倚)(在|着|了|在门)?[^，。！？；\n]{0,12}(等|等着|盯(着|了))"
        r"|(等|等着|等到?)(太阳|天亮|天黑|天放亮|下班|来人|车来|雨停|风停|消息|回信|通知|人散)"
        r"|了[一二三四五六七八九十百0-9]+(分钟|小时|钟头|刻钟)[，,](才|就|只|一直|仍|光)(等|站|蹲|坐|待|干坐)"
    )),
    # 注水·日常调度链：开门/开吊扇/烧水/擦桌/扫地/收拾店面这类零信息收拾动作成串出现
    # （"他先进去开了吊扇，又拎起暖水瓶摇了摇，半瓶底。他先没烧水。"）。命中即候选，
    # 评价师确认该动作串删掉后剧情是否有变化：无变化 → 删除；承载信息/落点 → 说明不适用
    ("注水·日常调度", re.compile(
        r"(开(了|起)?|关(了|上|掉)|拉亮|点亮|拉下|拉开)(吊扇|风扇|空调|电扇|日光灯|白炽灯|灯|卷帘门|推拉门)"
        r"|(拎起|提起|拿起|抓起|抄起|掂了掂|摇了摇|晃了晃|摸了摸|擦了擦)(暖水瓶|暖壶|水壶|水瓶|杯子|抹布|拖把|扫帚|鸡毛掸子)"
        r"|(烧水|擦桌子|擦柜台|擦镜子|扫地|拖地|收拾店面|打扫卫生|擦玻璃|倒垃圾|涮杯子)"
        r"|(先|又)?没(烧水|开门|开灯|开风扇|打扫)|(还没|也没)(烧水|开门|开灯|开风扇)"
    )),
    # 注水·空镜环境句：状态性/拟声性的孤立环境描写（"办公室的吊扇正转得起劲，满桌的纸页被风
    # 掀得哗啦响"这类不绑定人物观察/情绪、不给后文埋点的环境状态句）。命中即候选，评价师确认：
    # 无落点 → 删除；有落点（后文借它做论据/意象/伏笔，如"屋里没太阳，吊扇白晃晃地转，哪来的
    # 反光"）→ 说明不适用。注意只抓"状态+程度/拟声"的纯环境形，不抓人物动作句
    ("注水·空镜环境句", re.compile(
        r"(哗啦|沙沙|簌簌|呼啦|嘎吱|吱呀|嗡嗡|呼呼|哐当|叮当|嘀嗒|滴答)(作响|作声|声|响|着)"
        r"|(吊扇|风扇|电扇|窗帘|纸页|纸张|树叶|树枝|柳条|蝉|知了)(正|还在|仍)?(转|吹|飘|晃|响|叫|聒噪)(得|着)?(起劲|厉害|欢|不停|不止|哗啦|沙沙|簌簌|呼呼|呜呜|嗡嗡)"
        r"|(风|一阵风|风一(吹|掀|刮))(把|将)?[^，。！？；\n]{0,12}(掀|吹|刮|卷|晃)(得)?(哗啦|沙沙|簌簌|呼呼|乱响|作响)"
    )),
    # 表演式解说：作者替角色写"舞台指示"（"做出……该有的样子/应有的反应"），AI 味最重句式族。
    # 命中即候选，评价师确认或说明误报（真正自嘲/调侃式用法可不适用）
    ("表演式解说·该有的样子", re.compile(
        r"(该有的|应有的)(样子|反应|表情|姿态|神情)"
        r"|做出[^。！？；\n]{0,26}的样子"
    )),
    # 微表情/生理反应填充：耳根/脸颊/眼眶 发红发烫类 AI 凑细节（不服务情节即候选）
    ("微表情填充·生理反应", re.compile(
        r"(耳根|脸颊|面颊|眼眶|脖颈|脖子)(微微|渐渐|瞬间|肉眼可见)?(泛红|发红|涨红|红透|发烫|发烧|烧红)"
        r"|(脸|耳根)(一红|腾地红了|刷地红了|瞬间红了)"
    )),
    # 小动作填充：抬眼→低头→手指无意识搓/捏/攥 的零信息动作链（AI 扩写凑细节最爱）。
    # 命中即候选，评价师确认该动作是否暴露状态/推动剧情：无落点 → 删除；有落点 → 说明不适用
    ("小动作填充·动作链", re.compile(
        r"抬眼看了?[^，。！？；\n]{0,10}(又|便|随即|然后)?低下(头|眼)"
        r"|(手指|指尖|手)(无意识|下意识|不自觉|习惯性)?(地)?(搓|捏|摩挲|抠|攥|绞)(着|了)"
        r"|(手|拳头)(攥|捏|握)(成|了|紧)(拳|拳头)"
    )),
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
    # 破折号滥用·全章频率（确定性统计，不逐句定位）：≥2 处/千字即高频滥用候选。
    # 破折号是 AI 最爱用来"写完 X 再解说 X"的标点，频率单独成条交评价师核对；
    # 与上面的"破折号·后置解说"互补：频率管"用得多"，句式管"用得笨"。
    dash_n = text.count("——")
    if dash_n >= 2:
        per_k = dash_n * 1000 / len(text)
        if per_k >= 2.0:
            findings.append({
                "category": "破折号高频",
                "sentence": f"（全章统计）破折号共 {dash_n} 处（{per_k:.1f} 处/千字，≥2 处/千字即滥用候选）",
                "snippet": f"——×{dash_n}",
            })
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
    """统计文本的密度指纹：句长分布/变异、逗号密度、转折词、语气词、对话占比等。"""
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


# ---------- 5. 追读钩子确定性扫描（读者追读力对照材料：开篇钩子 / 章末悬念） ----------
# 与 ai_lint 同性质：程序预先算出来的字面信号，不是 LLM 感觉。评价师评「读者追读」维度时
# 必须逐条对照——命中信号确认成立写入评论/问题，或说明为何不适用，不允许沉默跳过。

# 开篇 300 字内直接进动作/冲突的触发词（命中即「有事件感」，有开篇钩子）
_OPENING_ACTION_PATTERNS = [
    r"猛地", r"突然", r"撞", r"摔", r"砸", r"拍", r"踹", r"踢", r"攥", r"掐", r"推",
    r"怒", r"吼", r"骂", r"冷笑", r"咬牙", r"刀", r"枪", r"血", r"杀", r"死", r"轰", r"炸",
    r"尖叫", r"喊", r"拦", r"挡",
]
# 章末 300 字内的悬念断点触发词（命中即「有章末钩子」）
_ENDING_SUSPENSE_PATTERNS = [
    r"突然", r"猛地", r"就在这时", r"与此同时", r"脚步声", r"推门", r"敲门", r"门被",
    r"回头", r"抬头", r"睁开眼", r"怔住", r"僵住", r"愣住", r"瞳孔", r"不可置信",
]
# 平淡收尾类（结尾 300 字命中即疑似无章末钩子：空镜/沉思/叹气/总结）
_ENDING_FLAT_PATTERNS = [
    r"望向", r"看向", r"眺望", r"陷入沉思", r"叹了口气", r"罢了", r"总之", r"如此",
    r"若有所思", r"笑了笑",
]


def scan_readthrough_hooks(text: str) -> dict:
    """确定性扫描章节的开篇钩子与章末悬念（供评价师评「读者追读」时对照）。

    输出 dict：
      opening_slice / ending_slice    开篇前 200 字、章末后 300 字原文
      opening_has_dialogue            开篇是否含对话
      opening_action_hits             开篇动作/冲突触发词列表
      opening_flat                    开篇无对话无动作冲突 → 疑似环境铺垫空转
      ending_question                 章末是否以问句收尾
      ending_suspense_hits            章末悬念断点触发词列表
      ending_flat                     章末无问句无悬念词且平淡收束 → 疑似无章末钩子
      dialogue_ratio                  全章对话占比（过低情绪感可能偏弱，仅参考）
    """
    raw = (text or "").strip()
    flat = re.sub(r"\s+", " ", raw)
    out = {
        "opening_slice": flat[:200],
        "opening_has_dialogue": bool(_QUOTE.findall(flat[:200])),
        "opening_action_hits": [p for p in _OPENING_ACTION_PATTERNS if re.search(p, flat[:300])],
        "opening_flat": False,
        "ending_slice": flat[-300:],
        "ending_question": bool(re.search(r"[？?]\s*$", flat)),
        "ending_suspense_hits": [],
        "ending_flat": False,
        "dialogue_ratio": None,
    }
    if not flat:
        return out
    out["ending_suspense_hits"] = [p for p in _ENDING_SUSPENSE_PATTERNS if re.search(p, flat[-300:])]
    if not out["ending_question"] and not out["ending_suspense_hits"]:
        out["ending_flat"] = any(re.search(p, flat[-300:]) for p in _ENDING_FLAT_PATTERNS)
    if not out["opening_has_dialogue"] and not out["opening_action_hits"]:
        out["opening_flat"] = True
    q = _QUOTE.findall(flat)
    out["dialogue_ratio"] = round(min(len(q) * 2.0 / max(len(flat), 1), 1.0), 3)
    return out


def format_readthrough_report(scan: dict) -> str:
    """把追读钩子扫描结果压成可注入提示词/展示的文本（无正文返回「无」）。"""
    if not (scan.get("opening_slice") or scan.get("ending_slice")):
        return "追读钩子扫描：无正文可扫。"
    lines = ["追读钩子扫描（程序确定性信号，评价「读者追读」时逐条对照）："]
    opening = scan.get("opening_slice") or ""
    lines.append(f"- 开篇前 200 字：{opening}…")
    flags: list[str] = []
    if scan.get("opening_has_dialogue"):
        flags.append("含对话")
    hits = scan.get("opening_action_hits") or []
    if hits:
        flags.append("含动作/冲突词：" + "、".join(hits[:5]))
    if scan.get("opening_flat"):
        flags.append("⚠ 无对话、无动作冲突 → 疑似环境铺垫空转（开篇钩子风险）")
    lines.append("  开篇信号：" + ("；".join(flags) if flags else "无明显钩子信号"))
    ending = scan.get("ending_slice") or ""
    lines.append(f"- 章末最后 300 字：…{ending}")
    flags2: list[str] = []
    if scan.get("ending_question"):
        flags2.append("以问句收尾（章末钩子）")
    hits2 = scan.get("ending_suspense_hits") or []
    if hits2:
        flags2.append("含悬念断点词：" + "、".join(hits2[:5]))
    if scan.get("ending_flat"):
        flags2.append("⚠ 平淡收束（无问句、无悬念词 → 章末钩子风险）")
    lines.append("  章末信号：" + ("；".join(flags2) if flags2 else "无明显章末钩子信号"))
    dr = scan.get("dialogue_ratio")
    if dr is not None:
        lines.append(f"- 全章对话占比 {dr:.0%}（过低时情绪感可能偏弱，仅作参考）")
    return "\n".join(lines)
