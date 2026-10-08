"""节奏服务：全书节奏密度统计（"自己书"节奏仪表盘 + 章标签口径）。

章标签（rhythm_tag）是章节级"情绪/节奏功能"标签，比 chapter_function（叙事功能）更粗粒度，
用于跨章统计爽点密度/过渡章连排/高潮分布——对应拆书教程的「给每一章贴标签：爽点章、冲突章、
过渡章、钩子章、高潮章」。
- 标签来源：作者在「执行收尾」维度确认 execution 候选时随候选携带（AI 建议，作者选定即确认）；
  自定义输入无标签。
- 存储位置：approved 大纲的 content.rhythm_tag（大纲即本章规划落库，切版本跟随批准版恢复）。
- 消费方：章节规划师（写本章前看到全书节奏坐标 + 连续过渡提醒）、小说家（知道本章该演什么节奏）。
"""
from typing import Optional
import re

from sqlalchemy.orm import Session

# 章标签枚举（单一事实源：prompt 校验/统计/前端展示共用）
RHYTHM_TAGS = ["爽点", "冲突", "过渡", "钩子", "高潮"]
RHYTHM_TAG_LABELS: dict[str, str] = {
    "爽点": "爽点章（情绪回报：展威/小胜/兑现/解气）",
    "冲突": "冲突章（对抗/博弈/危机，冲突为核心）",
    "过渡": "过渡章（铺垫/衔接/蓄势，弱回报）",
    "钩子": "钩子章（以悬念/新信息/钩子为核心，兑现偏少）",
    "高潮": "高潮章（卷级/大单元的情绪峰值）",
}


def is_valid_rhythm_tag(tag: Optional[str]) -> bool:
    """标签是否合法（None 或空视为未标注，合法；非枚举值非法）。"""
    if not tag:
        return True
    return tag in RHYTHM_TAGS


def get_approved_rhythm_tags(db: Session, novel_id) -> list[tuple[int, Optional[str]]]:
    """按章号升序取每章 approved 大纲的节奏标签。

    大纲即本章规划（轻量大纲），同一章多版本时只认批准版（与账本/设定口径一致）；
    某章无大纲或无标签返回 (chapter_no, None)，保证统计能对齐章号。
    """
    from app.db.models import Outline

    rows = (
        db.query(Outline.chapter_no, Outline.content)
        .filter(
            Outline.novel_id == novel_id,
            Outline.status == "approved",
            Outline.content.isnot(None),
        )
        .order_by(Outline.chapter_no)
        .all()
    )
    out: list[tuple[int, Optional[str]]] = []
    seen: set[int] = set()
    for chapter_no, content in rows:
        if chapter_no in seen:
            continue  # 同一章多个 approved（异常）只取第一条
        seen.add(chapter_no)
        tag = None
        if isinstance(content, dict):
            # 标签随执行收尾确认落库在 writing_treatment（规划即大纲）；兼容顶层旧写法
            tag = content.get("rhythm_tag") or (content.get("writing_treatment") or {}).get("rhythm_tag")
        out.append((chapter_no, tag if tag in RHYTHM_TAGS else None))
    return out


def consecutive_transition_count(tags: list[Optional[str]]) -> int:
    """最近连续「过渡」章数（从尾部倒推）。

    未标注（None）视为中断连续链：未知不等于过渡，宁可少报不可误报
    （避免把"未标注章"误判成过渡导致对下一章误加约束）。
    """
    n = 0
    for tag in reversed(tags):
        if tag == "过渡":
            n += 1
        else:
            break
    return n


def high_spot_gap(tags: list[Optional[str]]) -> Optional[int]:
    """距上一个「高潮」章之后隔了几章（不含高潮章自身）；无任何高潮章返回 None。

    用于"每 10 章一个中等级别高潮"的硬校验：gap ≥ 9 说明这个 10 章窗口将无高潮。
    tags 为当前章之前（不含当前章）的标签序列。
    """
    for i in range(len(tags) - 1, -1, -1):
        if tags[i] == "高潮":
            return len(tags) - 1 - i
    return None


# 阶段量级档位（爽点量级递增曲线的阶段注脚：立足 → 上升 → 顶峰）
STAGE_SCALE_NOTES = {
    "early": "立足期量级：爽点以小额/小胜/首个认可为主（第一单、第一次被记住），为后面升级留空间",
    "middle": "上升期量级：爽点明显上台阶（单子翻数倍、公开打脸、口碑扩散、地位提升），碾压前期",
    "late": "顶峰期量级：全书最大量级（决定性胜利、终极身份跃迁、封神/登顶时刻），回收全部主线",
}

# 冲突关键词（通用冲突词库，跨题材，不针对单一本书）：
# 按冲突类型分组合并成大表，覆盖主要题材的对抗/困境措辞——现实事业流（竞争/抹黑/整顿）、
# 玄幻高武（夺宝/围杀/瓶颈/心魔）、悬疑推理（命案/追查/凶手）、言情甜宠（误会/冷战/悔婚）、
# 灵异（诡异/诅咒/中邪）、生存危机（破产/负债/绝境/裁员）等。
# 刻意不含"资本/利益/资金/线索"这类在"积累/获得"中性语境也会出现的泛词（如"资本人脉备齐"
# "积累巨额办学资金"不是冲突，误伤会污染阶段卡）。
_CONFLICT_KEYWORDS = [
    # 通用对抗
    "冲突", "对抗", "较量", "博弈", "交锋", "争抢", "争夺", "对决", "对峙", "反目",
    "宣战", "挑衅", "翻盘", "仇敌",
    # 竞争 / 压制
    "竞争", "内卷", "压制", "打压", "刁难", "排挤", "嫉妒", "眼红", "使绊子", "穿小鞋",
    # 欺骗 / 诬陷
    "骗局", "圈套", "陷阱", "诬陷", "栽赃", "冤枉", "背锅", "洗稿", "抄袭", "抹黑", "中伤", "污蔑",
    # 危机 / 事故
    "危机", "事故", "突发", "故障", "失火", "坍塌", "泄漏", "翻车", "败露", "绝境",
    # 玄幻 / 冒险
    "围杀", "追杀", "夺宝", "厮杀", "暗算", "背叛", "叛变", "内奸", "卧底", "心魔", "瓶颈", "雷劫", "魔障",
    # 悬疑 / 推理
    "谜团", "凶手", "命案", "追查", "嫌疑", "真凶",
    # 灵异 / 恐怖
    "诡异", "异象", "鬼怪", "诅咒", "中邪",
    # 情感 / 言情
    "误会", "误解", "猜忌", "吃醋", "争吵", "冷战", "决裂", "退婚", "悔婚",
    # 压力 / 生存
    "压力", "困境", "破产", "负债", "裁员", "缺钱",
    # 时代 / 规则
    "乱象", "整顿", "核查", "监管", "审核", "整改", "禁令", "查封", "红线",
    # 情绪对抗
    "诱惑", "恶意", "纠纷", "受挫", "拒绝", "抵制", "风浪", "质疑", "看轻", "偏见",
]


def extract_volume_conflicts(focus: str, limit: int = 3) -> list[str]:
    """从分卷 focus 原文提取「本卷冲突/对手」线索短语（程序化、可复核，零 schema 改动）。

    作者的卷重点（focus）长文里往往已写明本卷的对手/困境（"与老机构老板利益冲突逐步激化"
    "遭遇同行恶意竞争抹黑"等）。按句切分 → 按顿/逗号切短语 → 取含冲突关键词的短语，
    供阶段卡展示"本阶段冲突/对手"——比全书 core_conflict 更贴合当前卷。
    直接读 focus 原文，旧蓝图立即生效；无命中返回空列表（调用方回退全书主线阻力）。
    """
    phrases: list[str] = []
    for seg in re.split(r"[。；\n]", focus):
        for ph in re.split(r"[、,，]", seg):
            ph = ph.strip()
            # 括号内容截断（避免"看遍行业唯利乱象（虚假承诺、贩卖焦虑…"这类残句）
            cut = ph.find("（")
            if cut != -1:
                ph = ph[:cut].strip()
            if len(ph) >= 4 and any(k in ph for k in _CONFLICT_KEYWORDS):
                phrases.append(ph)
    seen: set[str] = set()
    out: list[str] = []
    for p in phrases:  # 去重保序
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out[:limit]


def format_stage_card(blueprint, chapter_no: int) -> str:
    """阶段卡：当前阶段（前期/中期/后期）的核心目标 / 阻力 / 量级档位 / 近期关键转折。

    数据全部取自蓝图已有字段（volumes.focus=阶段目标、core_conflict=主线阻力、
    foreshadowing_plan=转折点），**不新增蓝图字段、不新增角色**：
    对应拆书教程「三阶段升级式」——每阶段的核心目标、困境、对手、爽点类型 + 关键转折点
    （身份跃迁/最大反转/伏笔回收），让规划师/小说家知道自己正处在全书的哪个坐标。
    无法推导（无蓝图/无章号）返回空串，调用方跳过。
    """
    from app.agents.context import STAGE_LABELS, derive_stage

    stage = derive_stage(chapter_no, blueprint)
    if not stage:
        return ""
    vols = (blueprint or {}).get("volumes") or []
    # 当前卷：章节范围覆盖 chapter_no 的卷；取不到回退按卷序号粗取
    cur_vol = None
    for v in vols:
        rng = str(v.get("chapters_range") or "")
        if "-" in rng:
            try:
                s, e = (int(x) for x in rng.split("-", 1))
                if s <= chapter_no <= e:
                    cur_vol = v
                    break
            except ValueError:
                continue
    focus = ""
    vol_txt = ""
    if cur_vol:
        parts = []
        if cur_vol.get("no") is not None:
            parts.append(f"第{cur_vol['no']}卷")
        if cur_vol.get("name"):
            parts.append(f"《{cur_vol['name']}》")
        if cur_vol.get("chapters_range"):
            parts.append(f"（第{cur_vol['chapters_range']}章）")
        vol_txt = "".join(parts)
        focus = str(cur_vol.get("focus") or "").strip()

    lines = [
        "【阶段卡】当前阶段：" + STAGE_LABELS.get(stage, stage) + (f"｜{vol_txt}" if vol_txt else "")
    ]
    if focus:
        lines.append(f"- 本阶段核心目标（卷重点）：{focus}")
    # 本阶段冲突/对手（三级降级，行结构稳定——永不因提取失败而缺块）：
    #   1) 从当前卷 focus 原文提取的本卷冲突短语（精确、贴合本卷）；
    #   2) 提取不到 → 全书主线阻力 core_conflict（粒度粗但有兜底）；
    #   3) 连 core_conflict 都没有 → 省略该行（此时蓝图过简，"目标/量级"仍在）。
    conflicts = extract_volume_conflicts(focus, limit=3) if focus else []
    cc = (blueprint or {}).get("core_conflict")
    cc_text = str(cc or "").strip()
    if conflicts:
        lines.append("- 本阶段冲突/对手：" + "、".join(conflicts))
    elif cc_text:
        lines.append(f"- 本阶段冲突/对手（全书主线）：{cc_text}")
    lines.append(f"- 爽点量级档位：{STAGE_SCALE_NOTES.get(stage, '')}")
    # 近期关键转折点：伏笔计划中回收章落在当前章后 10 章内的（最早 3 项）
    turns = []
    for fp in (blueprint or {}).get("foreshadowing_plan") or []:
        try:
            p = int(fp.get("payoff_chapter") or 0)
        except (TypeError, ValueError):
            continue
        if chapter_no < p <= chapter_no + 10:
            turns.append(f"第{p}章回收：{str(fp.get('desc') or '')[:28]}")
    if turns:
        lines.append("- 近期关键转折点（伏笔回收）：" + "；".join(sorted(turns)[:3]))
    return "\n".join(lines)


def _fmt_seq(tagged: list[tuple[int, Optional[str]]]) -> str:
    """标签序列压缩成可读文本：第1章 冲突 → 第2章 爽点 …（连续同标签合并计数）。"""
    if not tagged:
        return "（暂无已确认的节奏标签）"
    parts: list[str] = []
    for chapter_no, tag in tagged:
        if tag:
            parts.append(f"第{chapter_no}章 {tag}")
        else:
            parts.append(f"第{chapter_no}章 未标注")
    # 过长（>40 章）时只展示最近 30 章 + 开头，避免占满上下文
    if len(parts) > 34:
        head = parts[:4]
        tail = parts[-30:]
        return " → ".join(head) + f" …（中间省略 {len(parts) - 34} 章）… " + " → ".join(tail)
    return " → ".join(parts)


def compute_rhythm_dashboard(
    db: Session,
    novel_id,
    up_to_chapter: Optional[int] = None,
) -> str:
    """计算「自己书」节奏仪表盘摘要，注入规划师/小说家作为全书节奏坐标。

    统计口径：
    - 标签序列（已确认的 approved 大纲标签，按章号升序）；
    - 最近连续过渡章数（提示"本章不宜再是过渡"的硬信号）；
    - 距上一个爽点/高潮章的距离（爽点密度参照）；
    - 每 10 章内是否出现过爽点/高潮（稀疏检测）。
    up_to_chapter 传入后只统计其之前的章（规划本章前看已定稿节奏）。
    """
    tagged = get_approved_rhythm_tags(db, novel_id)
    if up_to_chapter:
        tagged = [(no, t) for no, t in tagged if no < up_to_chapter]
    if not tagged:
        return "【节奏仪表盘】暂无已定稿章节（或尚未确认节奏标签）。本章规划不受历史节奏约束。"

    seq = _fmt_seq(tagged)
    tags = [t for _, t in tagged]
    lines = [f"【节奏仪表盘·已定稿章节】{seq}"]

    # 连续过渡章（核心硬信号：教程"过渡章永远不超过两章"）
    ctrans = consecutive_transition_count(tags)
    if ctrans >= 2:
        lines.append(
            f"最近已连续 {ctrans} 章为过渡章——按节奏纪律本章【不宜再是过渡章】，"
            "应安排冲突/爽点/钩子等有推进力的功能。"
        )
    elif ctrans == 1:
        lines.append(
            f"最近 1 章为过渡章，本章仍可为过渡但再下一章必须上冲突或爽点（过渡章连排最多 2 章）。"
        )

    # 距上一个爽点/高潮章
    reward_chapters = [no for no, t in tagged if t in ("爽点", "高潮")]
    if reward_chapters:
        last = reward_chapters[-1]
        gap = (up_to_chapter or (tagged[-1][0] + 1)) - last - 1
        avg = (last - reward_chapters[0]) / max(len(reward_chapters) - 1, 1)
        lines.append(
            f"最近一个爽点/高潮章：第 {last} 章；当前距它已 {gap} 章。"
            f"已写部分爽点/高潮章平均间隔约 {avg:.1f} 章（参考：2-3 章一个爽点、每 10 章一个中高潮）。"
        )
    else:
        lines.append("已写章节尚无爽点/高潮章——尽早安排第一次情绪回报（对照题材族节奏骨架）。")

    # 每 10 章区间内爽点/高潮稀疏检测（密度软提示，口径=爽点/高潮）。
    # 注意与 stream.py 的硬校验口径不同：硬校验只看「高潮」标签（中高潮缺位=峰值纪律），
    # 这里是「爽点/高潮」密度提示（区间偏平告警）——两层刻意分开，不合并。
    max_no = tagged[-1][0]
    sparse = []
    for start in range(1, max_no + 1, 10):
        window = [no for no, t in tagged if start <= no < start + 10 and t in ("爽点", "高潮")]
        if not window:
            sparse.append(f"第{start}-{min(start + 9, max_no)}章区间无爽点/高潮")
    if sparse:
        lines.append("节奏告警：" + "；".join(sparse) + "（该区间可能整体偏平，规划本章时注意补位）。")

    return "\n".join(lines)
