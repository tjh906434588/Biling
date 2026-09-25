"""实体硬事实确定性核对（评价师/写后自检用）：把设定卡硬事实与正文做字面比对。

## 为什么需要这一层
蓝图对主角描述清晰，但对机构（如「江城人才信息服务部」）往往只有一句散文
（"2000年开始、2010年自主创业"）。大纲/正文/评价各自即兴加工后，
"这十年是一家机构还是多家""机构成立时间对不对""人员数量对不对"无法核对。
单靠 LLM 通读 7000 字蓝图做印象打分，漏检是常态（与 setting_checker 同根因）。

## 解法
① 硬事实定档：蓝图 timeline 激活时自动生成实体卡（structured.hard_facts 键值型，
   如 成立时间=2000年、人员规模=3人）；提取师「首次提及即冻结」回写锁定细节。
② 本模块把 hard_facts 抽出为可字面匹配的事实项，扫描本章正文：
   - 年份事实：正文出现「成立/创办…」紧邻另一个年份 → 候选冲突；
   - 量级事实：正文出现与定档不同的「数字+单位」且指向该实体/规模语境 → 候选冲突。

## 噪声控制（宁可少报，不可乱报）
- 只认 structured.hard_facts 键值型事实，散文式 locked_details 不参与机器核对；
- 年份冲突必须紧邻成立类锚点词（避免把"2003年他升职"当成立时间冲突）；
- 归属判定：实体名/别名在附近，或附近出现机构类词，否则不归责到该实体；
- 数量冲突必须单位一致、且处于实体名或规模语境的窗口内。
命中的是"候选冲突"（低置信度），交评价师逐条回应——与 setting_check 机制对齐。
"""
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

_YEAR_RE = re.compile(r"(1[89]\d{2}|20\d{2})")
_COUNT_RE = re.compile(r"(\d{1,4})\s*(名|人|家|间|位|个|所|处|台|套|辆|层|平方米|平米)")
# 成立/创办类锚点词：出现时其附近的年份才可能被判为「成立时间冲突」
_FOUNDING_KEYWORDS = (
    "成立", "创办", "创立", "开业", "创建", "建立", "组建", "起步",
    "开张", "建厂", "起源", "始于", "成立于", "创办于", "开门", "起家",
)
# 规模语境词：数量与实体名相距较远时，靠这些词判定确在描述规模
_SCALE_KEYWORDS = (
    "员工", "人员", "人手", "团队", "骨干", "店员", "职工", "编制",
    "规模", "一共有", "共有", "总共有", "伙计", "人干活", "几十", "几百",
)
# 机构类提示词：实体全名不在附近时，靠这些词把时间冲突归责到某家机构
_ENTITY_HINTS = (
    "公司", "部门", "单位", "中心", "事务所", "工作室", "中介", "机构",
    "集团", "服务部", "餐厅", "银行", "学校", "医院", "厂", "店", "局", "所",
)
_YEAR_FOUNDING_WINDOW = 14
_YEAR_ALIAS_WINDOW = 45
_COUNT_ALIAS_WINDOW = 40
_COUNT_SCALE_WINDOW = 15


def _find_kw(text: str, pos: int, kws: tuple, before: int, after: int) -> bool:
    lo = max(0, pos - before)
    hi = min(len(text), pos + after)
    return any(k in text[lo:hi] for k in kws)


def _snippet(text: str, pos: int, radius: int = 18) -> str:
    lo = max(0, pos - radius)
    hi = min(len(text), pos + radius + 4)
    return text[lo:hi].replace("\n", " ")


def extract_entity_facts(settings) -> list[dict]:
    """从设定卡 structured.hard_facts 抽出可确定性核对的事实项。

    只认「键值型硬事实」（如 成立时间=2000年、人员规模=3人）；
    散文式 locked_details 不参与机器核对（避免把"2000年他去打工"误判为成立时间）。
    """
    facts: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for s in settings:
        if s.type not in ("faction", "location", "character"):
            continue
        st = s.structured or {}
        hard = st.get("hard_facts")
        if not isinstance(hard, dict) or not hard:
            continue
        aliases = [str(a) for a in (s.aliases or []) if str(a).strip()] or []
        names = [str(s.name)] + aliases
        for k, v in hard.items():
            if v in (None, ""):
                continue
            vs = str(v).strip()
            key = (str(s.name), str(k))
            if key in seen:
                continue
            ym = _YEAR_RE.search(vs)
            if ym:
                facts.append({
                    "entity": str(s.name), "names": names, "fact": str(k) or "时间",
                    "fact_type": "year", "expected": int(ym.group(1)),
                    "expected_text": f"{ym.group(1)}年",
                })
                seen.add(key)
                continue
            cm = _COUNT_RE.search(vs)
            if cm:
                facts.append({
                    "entity": str(s.name), "names": names, "fact": str(k) or "量级",
                    "fact_type": "count", "expected": int(cm.group(1)), "unit": cm.group(2),
                    "expected_text": vs,
                })
                seen.add(key)
    return facts


def check_entity_facts(chapter_text: str, facts: list[dict]) -> list[dict]:
    """确定性核对本章正文与实体硬事实是否冲突（字面匹配，宁可少报不可乱报）。

    返回项与 setting_check 同构（rule/group/present/missing/source），
    额外带 entity/fact/expected_text/found/evidence/kind 供评价师与前端展示。
    """
    if not facts or not (chapter_text or "").strip():
        return []
    text = chapter_text
    items: list[dict] = []
    emitted: set[tuple[str, str]] = set()
    for f in facts:
        fkey = (f["entity"], f["fact"])
        if fkey in emitted:
            continue
        found = _check_year_conflict(text, f) if f["fact_type"] == "year" else _check_count_conflict(text, f)
        if found is None:
            continue
        emitted.add(fkey)
        items.append({
            "rule": f"{f['entity']}·{f['fact']}",
            "group": [f"{f['fact']}应等于{f['expected_text']}"],
            "present": [found["found"]],
            "missing": [],
            "source": "entity",
            "kind": "entity_conflict",
            "entity": f["entity"],
            "fact": f["fact"],
            "expected_text": f["expected_text"],
            "found": found["found"],
            "evidence": found["evidence"],
        })
    return items


def _check_year_conflict(text: str, f: dict) -> Optional[dict]:
    for m in _YEAR_RE.finditer(text):
        y = int(m.group(1))
        if y == f["expected"]:
            continue
        p = m.start()
        # 必须紧邻成立类锚点词（如「成立于1998年」），避免把"2003年他升职"误判
        if not _find_kw(text, p, _FOUNDING_KEYWORDS, _YEAR_FOUNDING_WINDOW, 2):
            continue
        # 归属：实体名/别名在附近，或附近出现机构类词（如「那家人才中介」）
        if not _find_kw(text, p, tuple(f["names"]), _YEAR_ALIAS_WINDOW, _YEAR_ALIAS_WINDOW) \
           and not _find_kw(text, p, _ENTITY_HINTS, _YEAR_FOUNDING_WINDOW + 8, 8):
            continue
        return {"found": f"{y}年", "evidence": _snippet(text, p)}
    return None


def _check_count_conflict(text: str, f: dict) -> Optional[dict]:
    for m in _COUNT_RE.finditer(text):
        n = int(m.group(1))
        if n == f["expected"] or m.group(2) != f["unit"]:
            continue
        p = m.start()
        # 归属：实体名/别名在附近，或附近是规模语境
        if not _find_kw(text, p, tuple(f["names"]), _COUNT_ALIAS_WINDOW, _COUNT_ALIAS_WINDOW) \
           and not _find_kw(text, p, _SCALE_KEYWORDS, _COUNT_SCALE_WINDOW, _COUNT_SCALE_WINDOW):
            continue
        return {"found": f"{n}{m.group(2)}", "evidence": _snippet(text, p)}
    return None


def format_hard_facts_snapshot(settings, limit: int = 16) -> str:
    """作家类写前注入：把实体卡的硬事实压成短清单（供 REQUIRED 组件，不可被裁剪）。

    只含机构/地点/角色三类的键值型硬事实，正文出现这些实体时不得与之矛盾。
    """
    lines: list[str] = []
    for s in settings:
        if s.type not in ("faction", "location", "character"):
            continue
        st = s.structured or {}
        hard = st.get("hard_facts")
        if not isinstance(hard, dict) or not hard:
            continue
        bits = [f"{k}={v}" for k, v in hard.items() if v not in (None, "")]
        if not bits:
            continue
        lines.append(f"- {s.name}：{'；'.join(bits)}")
        if len(lines) >= limit:
            break
    if not lines:
        return ""
    return (
        "【实体硬事实·数据化定档（不是参考，是已确立的事实）】\n"
        + "\n".join(lines)
        + "\n正文出现这些实体时，名称、数字、年份必须与硬事实一致；首次提及即采用硬事实里的说法，不得自造或改写。"
    )


def format_conflicts_for_prompt(items: list[dict]) -> str:
    """把实体核对结果格式化成注入评价师 prompt 的文本。"""
    if not items:
        return "（实体硬事实核对未发现矛盾）"
    lines = []
    for it in items:
        lines.append(
            f"- 实体《{it['entity']}》的「{it['fact']}」已定档为「{it['expected_text']}」，"
            f"本章正文出现与之不符的表述「{it['found']}」（原文：{it.get('evidence', '')}）。"
            "若正文确属故意推翻设定（如作者安排机构变更），必须先改实体卡硬事实，"
            "否则即判定为与上文已确立事实冲突。"
        )
    return "\n".join(lines)


# ---------- 机构档案完整性（第二层：设定本身的"内容质量"，不是防矛盾） ----------
# 解决"机构只有名字+一句散文，老板/规模/业务/位置是否符合时代无从核对"。
# 程序只做确定性部分：列出每张机构卡的档案维度 有/缺；"是否符合年代"交给评价师判断。

# 档案维度 → 判定关键词（命中任一即视为"该维度已写"）
_ORG_DIMENSION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "成立时间": ("成立时间", "起始时间", "成立年份", "创办时间", "开业时间", "成立于", "始创于"),
    "负责人": ("负责人", "老板", "店主", "掌门", "经理", "经理人"),
    "人员规模": ("人员规模", "人员", "员工数", "店员", "职工数", "规模", "人手"),
    "业务范围": ("业务范围", "业务", "经营范围", "经营内容", "主营", "职能", "主营项目"),
    "位置布局": ("位置布局", "位置", "地址", "位于", "坐落", "门面", "门店", "地段", "开在"),
    "时代特征": ("时代特征", "时代背景", "时代", "年代", "当时", "时期"),
}
ORG_ARCHIVE_DIMENSIONS = tuple(_ORG_DIMENSION_KEYWORDS.keys())


def _collect_org_text(st: dict, description: str = "") -> str:
    """把机构卡的全部文本信息拼成一个 haystack，供维度命中检测。

    键名与值一并纳入：structured 的维度键名（如"成立时间""负责人"）本身即是权威标注，
    即使值里没有重复关键词（如值"2000年之前已存在"不含"成立于"），也应视为已定档。
    """
    parts: list[str] = []
    if description:
        parts.append(str(description))
    if isinstance(st, dict):
        hard = st.get("hard_facts")
        if isinstance(hard, dict):
            for k, v in hard.items():
                parts.append(f"{k}={v}")
        locked = st.get("locked_details")
        if isinstance(locked, list):
            parts.extend(str(x) for x in locked)
        for k, v in st.items():
            if k in ("hard_facts", "locked_details", "constitution_text", "dynamic_text"):
                continue
            if isinstance(v, (str, int, float)):
                parts.append(str(v))
            parts.append(str(k))  # 键名纳入命中检测：维度键即权威标注
    return "\n".join(parts)


def _org_archive_status(s) -> dict:
    """机构卡的档案维度现状：{维度: True/False}。"""
    st = s.structured or {}
    hay = _collect_org_text(st, s.description or "")
    return {
        dim: any(k in hay for k in kws)
        for dim, kws in _ORG_DIMENSION_KEYWORDS.items()
    }


def check_org_archive_gaps(chapter_text: str, settings) -> list[dict]:
    """正文出现的机构卡，若档案缺维度则报"缺失项"（与 setting_check 同构）。

    只在正文里出现过的机构才检查——第八章写到了「江城人才信息服务部」，
    那么这家机构的老板/规模/业务/位置有没有定档，是作者当下就需要知道的。
    """
    text = (chapter_text or "").strip()
    if not text:
        return []
    items: list[dict] = []
    for s in settings:
        if s.type != "faction":
            continue
        names = [str(s.name)] + [str(a) for a in (s.aliases or []) if str(a).strip()]
        if not any(n and n in text for n in names):
            continue
        status = _org_archive_status(s)
        missing = [dim for dim, has in status.items() if not has]
        if not missing:
            continue
        items.append({
            "rule": f"{s.name}·机构档案",
            "group": [f"机构档案缺维度：{'、'.join(missing)}"],
            "present": [],
            "missing": missing,
            "source": "entity",
            "kind": "org_archive_gap",
            "entity": str(s.name),
            "fact": "机构档案",
            "expected_text": "（档案缺：%s）" % "、".join(missing),
            "found": "",
            "evidence": "该机构卡仅有：%s" % (
                "；".join(f"{d}" for d, h in status.items() if h) or "无档案内容"
            ),
        })
    return items


def format_org_archive_snapshot(settings) -> str:
    """列出所有机构卡的档案维度现状（供评价师判断"是否符合时代/是否该补"）。"""
    lines: list[str] = []
    for s in settings:
        if s.type != "faction":
            continue
        status = _org_archive_status(s)
        bits = "；".join(f"{d}={('有' if h else '缺')}" for d, h in status.items())
        lines.append(f"- {s.name}：{bits}")
    if not lines:
        return "（设定库暂无机构卡）"
    return (
        "【机构档案完整性·程序列出的各机构档案维度现状（不是猜测）】\n"
        + "\n".join(lines)
        + "\n对每个机构：维度为「缺」的，评价时不得视为已有设定；"
        "若本章涉及该机构且缺关键维度（负责人/人员规模/业务范围），应写入 issues 提示补齐；"
        "现实题材下，机构形态/老板画像/业务范围若明显不符合设定年代（如 2000 年用线上 APP、"
        "老板是 90 后大学生创业），也必须写入 issues。"
    )


def format_org_gaps_for_prompt(items: list[dict]) -> str:
    """把机构档案缺失项格式化成注入评价师 prompt 的文本。"""
    if not items:
        return "（正文涉及的机构档案维度均已定档）"
    lines = []
    for it in items:
        lines.append(
            f"- 正文出现了机构《{it['entity']}》，但该机构卡档案缺少维度："
            f"{'、'.join(it['missing'])}。本章涉及该机构时不得把这些维度写成已确立事实，"
            "并应在 issues 中提示补齐（severity 至少 low）。"
        )
    return "\n".join(lines)
