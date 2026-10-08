"""角色上下文装配辅助：取设定/记忆/账本快照，并按模型上下文窗口用 token 预算器裁剪组件。

token 预算器（本模块尾部）：各角色把上下文拆成「可裁剪组件」（ComponentBlock，带优先级），
run 前按模型 context_window 估算总 token，超窗时从低优先级组件起剔除，直到不超窗。
硬约束（优先级 PRIORITY_REQUIRED）永不剔除；被剔除的组件记入 ctx.truncated_components。
"""
import uuid
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import (
    Blueprint,
    Chapter,
    ChapterVersion,
    EntityRelation,
    Novel,
    PlotLedger,
    Setting,
    StoryState,
)

# 默认输出预留：输入上下文预算 = context_window - 输出预留（给 max_tokens 兜底，防输出占不满被裁输入）。
DEFAULT_OUTPUT_RESERVE = 8192


def get_novel(db: Session, novel_id: uuid.UUID) -> Optional[Novel]:
    """按 id 取小说行（无则 None）。"""
    return db.get(Novel, novel_id)


def get_chapter_author_directives(db: Session, novel_id: uuid.UUID, chapter_no) -> list[dict]:
    """作者对本章的历史修改意见（意见持久化，M 增强）。

    评价优化时提交的 author_note 会落库到 chapters.author_directives；重新生成/规划/
    续写本章时，novelist / chapter_planner 读取并注入，防止作者指出过的问题再次出现。
    返回 list[{text, version_no, created_at}]（按记录先后）。
    """
    if not chapter_no:
        return []
    try:
        chapter_no = int(chapter_no)
    except (TypeError, ValueError):
        return []
    if chapter_no <= 0:
        return []
    chapter = db.execute(
        select(Chapter).where(Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no)
    ).scalar_one_or_none()
    if chapter is None:
        return []
    directives = [d for d in (chapter.author_directives or []) if isinstance(d, dict)]
    return [d for d in directives if str(d.get("text") or "").strip()]


def get_approved_outline_ids(db: Session, novel_id: uuid.UUID) -> set[str]:
    """各章当前批准版大纲 id（字符串集合）；大纲注入的设定/账本据此判断可见性。"""
    from app.db.models import Outline

    return {
        str(x)
        for x in db.execute(
            select(Outline.id).where(Outline.novel_id == novel_id, Outline.status == "approved")
        ).scalars()
    }


def get_visible_open_ledger(db: Session, novel_id: uuid.UUID) -> list[PlotLedger]:
    """open 账本行：与设定同逻辑，大纲来源（source="outline"）只返回「来源版本仍批准」的行，
    切版本后隐藏（不删除，切回恢复）；其余来源（提取师/手动）恒可见。

    伏笔状态机（status 取值，按注入可见性分组）：
    - 活跃（注入可见）：open（已埋设/待回收）、progressing（正在推进/读者能看到它在动）、
      deferred（暂时搁置/回收期延后但仍在账上）；
    - 终结（注入隐藏）：closed（已回收）、abandoned（废弃）、superseded（被新线索取代）。
    """
    rows = list(
        db.execute(
            select(PlotLedger).where(
                PlotLedger.novel_id == novel_id,
                PlotLedger.status.in_(("open", "progressing", "deferred")),
            )
        ).scalars()
    )
    approved = get_approved_outline_ids(db, novel_id)
    return [
        r
        for r in rows
        if r.source != "outline" or (r.outline_id is not None and str(r.outline_id) in approved)
    ]


# 伏笔债务窗口（章）：target_reveal_chapter 超过当前章数 ≤ 该值视为「逼近揭示」，
# 超过（已过揭示期仍未回收）视为「超期=债务」。
LEDGER_DEBT_APPROACH_WINDOW = 2


def compute_ledger_debt(db: Session, novel_id: uuid.UUID, up_to_chapter: int) -> dict:
    """伏笔债务追踪（webnovel-writer 债务引擎思想移植，只读计算，不改账本）：

    对活跃伏笔（含 target_reveal_chapter 计划揭示章的）按当前写到第几章分类：
    - overdue（债务）：已过计划揭示章仍未回收 → 正文越写越远，越容易烂尾，必须尽快处理；
    - approaching（逼近）：距计划揭示章 ≤ LEDGER_DEBT_APPROACH_WINDOW 章 → 近期该回收/推进了；
    - on_track（正常）：还有充足章数，不催促。

    返回 {"overdue": [PlotLedger], "approaching": [PlotLedger], "overdue_count": int, "up_to_chapter": int}。
    未设 target_reveal_chapter 的行不参与分类（无揭示期的悬念按 open 正常注入）。
    """
    rows = get_visible_open_ledger(db, novel_id)
    overdue: list[PlotLedger] = []
    approaching: list[PlotLedger] = []
    for r in rows:
        t = r.target_reveal_chapter
        if not t:
            continue
        if t < up_to_chapter:
            overdue.append(r)
        elif t - up_to_chapter <= LEDGER_DEBT_APPROACH_WINDOW:
            approaching.append(r)
    overdue.sort(key=lambda r: (not r.is_pinned, -(r.urgency or 0), r.target_reveal_chapter or 0))
    approaching.sort(key=lambda r: (r.target_reveal_chapter or 0, -(r.urgency or 0)))
    return {
        "overdue": overdue,
        "approaching": approaching,
        "overdue_count": len(overdue),
        "up_to_chapter": up_to_chapter,
    }


def format_ledger_debt_report(debt: dict) -> str:
    """把债务追踪结果压成注入文本（critic/novelist 共用；无债务返回占位）。"""
    overdue = debt.get("overdue") or []
    approaching = debt.get("approaching") or []
    if not overdue and not approaching:
        return "伏笔债务：无超期、无逼近揭示的伏笔（全部在计划揭示期内）。"
    up_to_chapter = debt.get("up_to_chapter") or 0
    lines = ["伏笔债务追踪（按计划揭示章核对，正文推进不可无限拖延）："]
    if overdue:
        lines.append(f"- 超期未回收（已过揭示章 {len(overdue)} 条，优先级最高的必须先处理）：")
        for r in overdue[:6]:
            t = r.target_reveal_chapter or 0
            overrun = max(1, up_to_chapter - t) if t else "?"
            lines.append(
                f"  [#{str(r.id)[:8]}][{r.item_type}] {r.description}"
                f"（第{r.chapter_introduced or '?'}章埋，计划第{t}章揭示，已超 {overrun} 章）"
            )
    if approaching:
        lines.append(f"- 逼近揭示（{len(approaching)} 条，1-{LEDGER_DEBT_APPROACH_WINDOW} 章内应回收/推进）：")
        for r in approaching[:6]:
            lines.append(
                f"  [#{str(r.id)[:8]}][{r.item_type}] {r.description}"
                f"（第{r.chapter_introduced or '?'}章埋，计划第{r.target_reveal_chapter}章揭示）"
            )
    return "\n".join(lines)


def filter_graph_relations_for_version(
    db: Session, novel_id: uuid.UUID, rows: list[EntityRelation]
) -> list[EntityRelation]:
    """图谱关系版本化过滤（注入与图谱展示页共用，fail-closed）：
    - dynamic 关系：提取时正文版本（chapter_version_id）必须 == 该章当前激活版本才保留；
      无版本记录的旧数据同样过滤（需重新提取对齐后恢复）。
    - 被取代（archived）的旧关系：取代者提取版本（superseded_by_version）仍在当前激活集合时
      才视为失效过滤；切回旧版本（取代者版本不在激活集合）时旧关系「复活」保留，
      消除取代链跨版本空档（旧关系与取代者同时被过滤导致整章关系消失）。
    """
    active_version_ids = set(
        db.execute(
            select(ChapterVersion.id)
            .join(Chapter, Chapter.id == ChapterVersion.chapter_id)
            .where(Chapter.novel_id == novel_id, ChapterVersion.is_active.is_(True))
        ).scalars()
    )
    out: list[EntityRelation] = []
    for r in rows:
        if r.type != "dynamic":
            out.append(r)
            continue
        if r.chapter_version_id is None or r.chapter_version_id not in active_version_ids:
            continue  # 提取版本对不上当前激活版本 → 跳过（防版本切换残留）
        if r.archived:
            # 取代者版本已不在当前激活集合（用户切回旧版本）→ 旧关系复活；否则保持失效
            if r.superseded_by_version is not None and r.superseded_by_version not in active_version_ids:
                out.append(r)
            continue
        out.append(r)
    return out


def get_graph_relations_text(db: Session, novel_id: uuid.UUID, limit: int = 60) -> str:
    """实体关系图谱摘要（写作/审稿的一致性对照依据，不含方向性修饰）。

    版本校验（fail-closed，与 story_state 一致）：dynamic 关系只注入「提取时正文版本 ==
    该章当前激活版本」的行；切回旧版本但未重新提取时，该章旧版人物关系整章跳过，
    防止版本切换后把已切换走的版本人物带入正文。无版本记录（chapter_version_id 为空）
    的旧数据同样跳过注入，需重新提取对齐后恢复。被取代的旧关系在取代者版本仍激活时
    视为失效不注入；切回旧版本时旧关系恢复（见 filter_graph_relations_for_version）。
    """
    rows = list(db.execute(select(EntityRelation).where(EntityRelation.novel_id == novel_id)).scalars())
    if not rows:
        return "（图谱暂无关系）"
    rows = filter_graph_relations_for_version(db, novel_id, rows)
    if not rows:
        return "（图谱暂无关系）"
    # AI 需要当前关系快照：按 (source, relation, target) 三元组去重，每组取最新确立的一条
    # （created_at 升序遍历，后者覆盖前者）。同一对实体可以存在多个**共存**关系
    # （如「A 同事 B」「A 朋友 B」同时成立）——全部注入；被**取代**的旧关系
    # （如「师徒」→「叛出师门」）在取代者版本仍激活时被过滤，保证注入不含过时关系；
    # 切回旧版本时取代者不激活、旧关系复活，正好反映旧版本当时的故事状态。
    latest: dict[tuple[str, str, str], EntityRelation] = {}
    for r in rows:
        latest[(r.source, r.relation, r.target)] = r
    uniq = list(latest.values())
    # 最新确立的优先；超过上限时截断，保证注入的是最新故事状态
    uniq.sort(key=lambda r: (r.chapter_no or 0), reverse=True)
    lines = []
    for r in uniq[:limit]:
        extra = f"（第{r.chapter_no}章确立）" if r.chapter_no else ""
        lines.append(f"- {r.source} —{r.relation}→ {r.target} [剧情{extra}]")
    return "\n".join(lines)


def get_settings_snapshot(db: Session, novel_id: uuid.UUID, limit: int | None = None) -> list[Setting]:
    """取设定快照：不可变（宪法）优先，其余按最近更新优先；上限默认取自配置。

    蓝图导入的设定（source="blueprint"）按版本存储：只注入「当前生效蓝图」版本，
    其余版本隐藏（可切回恢复）；手动/批量设定（source=batch/manual）始终注入。

    大纲注入的设定（source="outline"）记录来源大纲版本（outline_ids，可跨章多值）：
    只要任一来源版本仍是「该章当前批准版」即可见；全部来源不再批准时隐藏
    （不删除，切回任意来源版本即恢复，无需重新提取）。
    """
    from app.db.models import Blueprint, Outline

    limit = limit or get_settings().settings_snapshot_limit
    # 当前生效蓝图的 id（无则 None → 蓝图设定整体不注入）
    active_bp_id = db.execute(
        select(Blueprint.id)
        .where(Blueprint.novel_id == novel_id, Blueprint.status == "active")
        .order_by(Blueprint.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    all_rows = list(
        db.execute(
            select(Setting).where(Setting.novel_id == novel_id, Setting.deleted_at.is_(None))
        ).scalars()
    )
    # 各章当前批准版大纲 id（无则空集 → outline 注入设定整体隐藏）；与 outline_ids 均按字符串比较
    approved_outline_ids = {
        str(x)
        for x in db.execute(
            select(Outline.id).where(Outline.novel_id == novel_id, Outline.status == "approved")
        ).scalars()
    }
    rows = [
        s
        for s in all_rows
        if s.source != "blueprint" or (s.blueprint_id is not None and s.blueprint_id == active_bp_id)
    ]
    rows = [
        s
        for s in rows
        if s.source != "outline" or (s.outline_ids and any(o in approved_outline_ids for o in s.outline_ids))
    ]

    def has_constitution(s: Setting) -> bool:
        if s.is_constitution:
            return True
        st = s.structured or {}
        return bool((st.get("constitution_text") or "").strip())

    def sort_key(s: Setting):
        ts = s.updated_at.timestamp() if s.updated_at else 0.0
        # 关键信息固化（C）：is_pinned 与宪法同级优先——固化项永远排在前面、截断时绝不丢失
        return (0 if (has_constitution(s) or s.is_pinned) else 1, -ts)

    rows.sort(key=sort_key)
    # 固化项永不被数量上限挤出：截断只发生在非固化项之间
    if limit is not None and len(rows) > limit:
        pinned = [s for s in rows if s.is_pinned]
        if len(pinned) >= limit:
            return pinned[:limit]
        rows = pinned + [s for s in rows if not s.is_pinned][: limit - len(pinned)]
    return rows


# 阶段标签（structured.stages 用英文枚举，展示层映射中文）
STAGE_LABELS = {"early": "前期", "middle": "中期", "late": "后期"}


def derive_stage(chapter_no: int, blueprint: dict | None) -> Optional[str]:
    """按当前章节号从蓝图分卷推导所处阶段（早期/中期/后期）。

    以分卷为阶段单元：把卷按序号三等分，阶段边界落在整卷上（卷是叙事阶段的最小单元，
    避免阶段标签在卷内跳变——如 6 卷书 → 卷 1-2 前期 / 卷 3-4 中期 / 卷 5-6 后期）。
    无法按卷定位（无蓝图 / 卷范围不覆盖该章 / 章范围缺失）时，回退总章数三等分（旧逻辑）。
    """
    if not blueprint or chapter_no <= 0:
        return None
    vols = blueprint.get("volumes") or []
    if not vols:
        return None

    # 优先：按卷序号三等分（阶段边界 = 卷边界）
    idx: Optional[int] = None
    for i, v in enumerate(vols, start=1):
        rng = str(v.get("chapters_range") or "")
        if "-" in rng:
            try:
                s, e = (int(x) for x in rng.split("-", 1))
            except ValueError:
                continue
            if s <= chapter_no <= e:
                idx = i
                break
    if idx is not None:
        third = len(vols) / 3.0
        if idx <= third:
            return "early"
        if idx <= third * 2:
            return "middle"
        return "late"

    # 回退：总章数三等分（无法定位到具体卷时，按全书体量分）
    total = None
    for v in vols:
        rng = str(v.get("chapters_range") or "")
        if "-" in rng:
            try:
                end = int(rng.rsplit("-", 1)[-1].strip())
                total = max(total or 0, end)
            except ValueError:
                continue
    if not total or total <= 0:
        return None
    third = total / 3
    if chapter_no <= third:
        return "early"
    if chapter_no <= third * 2:
        return "middle"
    return "late"


def filter_settings_for_chapter(
    settings: list[Setting], chapter_no: int, stage: Optional[str] = None
) -> list[Setting]:
    """按写作进度过滤设定：
    - appear_ranges（structured 内 {from, until} 列表）限定多段不连续生效范围；
    - appear_from/appear_until（structured 内整数）限定单段生效范围（旧数据格式）；
    - stages（structured 内枚举列表）需命中当前阶段；无法推导阶段（stage=None）时不按阶段过滤。
    """
    out = []
    for s in settings:
        st = s.structured or {}
        ranges = st.get("appear_ranges")
        if isinstance(ranges, list) and ranges:
            hit = False
            for r in ranges:
                if not isinstance(r, dict):
                    continue
                lo = r.get("from")
                hi = r.get("until")
                if isinstance(lo, int) and chapter_no < lo:
                    continue
                if isinstance(hi, int) and chapter_no > hi:
                    continue
                hit = True
                break
            if not hit:
                continue
        else:
            appear_from = st.get("appear_from")
            appear_until = st.get("appear_until")
            if isinstance(appear_from, int) and chapter_no < appear_from:
                continue
            if isinstance(appear_until, int) and chapter_no > appear_until:
                continue
        stages = st.get("stages")
        if stage and isinstance(stages, list) and stages and stage not in stages:
            continue
        out.append(s)
    return out


def get_story_states_matching_active(db: Session, novel_id: uuid.UUID) -> list[StoryState]:
    """该小说全部「快照正文版本 == 该章当前激活版本」的记忆快照（按章号升序）。

    版本校验（fail-closed）：切回旧定稿版但未重新提取时，该章快照对不上当前激活版本，
    整条跳过——宁可缺一段记忆，也绝不让过期版本快照冒充当前正文注入给 AI（防时间泄漏）。
    重新提取该章后快照刷新为激活版本，自动恢复注入。
    """
    return list(
        db.execute(
            select(StoryState)
            .join(
                Chapter,
                (Chapter.novel_id == StoryState.novel_id)
                & (Chapter.chapter_no == StoryState.chapter_no),
            )
            .join(
                ChapterVersion,
                (ChapterVersion.chapter_id == Chapter.id)
                & ChapterVersion.is_active.is_(True),
            )
            .where(
                StoryState.novel_id == novel_id,
                StoryState.chapter_version_id == ChapterVersion.id,
            )
            .order_by(StoryState.chapter_no.asc())
        ).scalars()
    )


def get_recent_story_states(db: Session, novel_id: uuid.UUID, limit: int = 3) -> list[StoryState]:
    """最近 limit 章已提取且版本对得上当前激活正文的记忆快照（按章号降序）。"""
    states = get_story_states_matching_active(db, novel_id)
    return states[-limit:][::-1]


def get_recent_chapters(db: Session, novel_id: uuid.UUID, limit: int = 2) -> list[Chapter]:
    """最近 limit 章已定稿（status=complete）的章节，章号降序（最新在前）。"""
    return list(
        db.execute(
            select(Chapter)
            .where(Chapter.novel_id == novel_id, Chapter.status == "complete")
            .order_by(Chapter.chapter_no.desc())
            .limit(limit)
        ).scalars()
    )


def get_latest_memory(db: Session, novel_id: uuid.UUID) -> Optional[dict]:
    """取最新一份作品编年总览 content（无则 None）。"""
    from app.db.models import NovelMemory

    row = db.execute(
        select(NovelMemory)
        .where(NovelMemory.novel_id == novel_id)
        .order_by(NovelMemory.up_to_chapter.desc(), NovelMemory.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    return row.content if row is not None else None


def format_memory_prompt(content: dict | None) -> str:
    """把编年总览压成注入文本；无编年返回占位（不阻塞，agent 按正常流程写）。"""
    if not content:
        return "作品编年：暂无（长篇小说早期主线/伏笔请以设定库、关系图谱与伏笔账本为准）。"
    lines = [f"主线：{content.get('main_line') or '（无）'}"]
    arcs = content.get("volumes_progress") or []
    if arcs:
        lines.append(
            "各线进度："
            + "；".join(f"{a.get('name')}（{a.get('status')}）→{a.get('progress')}" for a in arcs)
        )
    goals = content.get("character_goals") or []
    if goals:
        lines.append(
            "角色目标："
            + "；".join(f"{g.get('character')}：{g.get('goal')}（{g.get('progress')}）" for g in goals)
        )
    fw = content.get("active_foreshadowing") or []
    if fw:
        lines.append(
            "未回收伏笔："
            + "；".join(f"第{f.get('since_chapter')}章埋的「{f.get('desc')}」（提示：{f.get('hint') or '无'}）" for f in fw)
        )
    world = content.get("established_world") or []
    if world:
        lines.append("已确立设定：" + "；".join(world))
    threads = content.get("open_threads") or []
    if threads:
        lines.append("未解线索：" + "；".join(threads))
    nd = content.get("next_direction") or ""
    if nd:
        lines.append(f"后续走向：{nd}")
    return "【作品编年（长期记忆，跨窗口，写作/评价时须与此一致）】\n" + "\n".join(lines)


def get_active_blueprint(db: Session, novel_id: uuid.UUID) -> Optional[dict]:
    """取当前 active 蓝图的 content（无则 None）。"""
    bp = db.execute(
        select(Blueprint)
        .where(Blueprint.novel_id == novel_id, Blueprint.status == "active")
        .order_by(Blueprint.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    return bp.content if bp else None


def format_blueprint_for_prompt(content: dict | None) -> str:
    """把蓝图 dict 压成角色提示词用的紧凑摘要（防超长）。"""
    if not content:
        return "（暂无 active 蓝图）"
    parts = [
        f"标题：{content.get('title')}",
        f"一句话：{content.get('logline')}",
        f"主题：{content.get('theme')}",
        f"核心冲突：{content.get('core_conflict')}",
    ]
    anchor = content.get("opening_anchor")
    if isinstance(anchor, dict):
        anchor_bits = []
        if str(anchor.get("first_chapter_slice") or "").strip():
            anchor_bits.append(f"第1章时间切片：{anchor['first_chapter_slice']}")
        reveal = anchor.get("golden_finger_reveal_chapter")
        if reveal:
            anchor_bits.append(f"金手指揭示章：第{reveal}章")
        if anchor_bits:
            parts.append("开篇锚点（作者已拍板，规划/写作必须遵守）：" + "；".join(anchor_bits))
    if content.get("total_word_count"):
        parts.append(f"全书体量：{content.get('total_word_count')}")
    if content.get("total_chapters"):
        parts.append(f"总章数：{content.get('total_chapters')}")
    if content.get("chapter_word_count"):
        parts.append(f"单章字数：{content.get('chapter_word_count')}")
    rules = content.get("world_rules") or []
    if rules:
        rule_bits = []
        for r in rules[:8]:
            # 注意：constraints 是作者写的硬约束，曾经整段被丢掉（只取 name+detail），
            # 导致蓝图里 14 条硬规则从未进入任何 Agent 的视野。这里必须带上。
            bit = f"{r.get('name')}（{r.get('detail')}"
            cons = [str(c).strip() for c in (r.get("constraints") or []) if str(c).strip()]
            if cons:
                bit += "。硬性约束：" + "；".join(cons)
            bit += "）"
            rule_bits.append(bit)
        parts.append("世界规则：" + "；".join(rule_bits))
    arcs = content.get("character_arcs") or []
    if arcs:
        parts.append("人物弧：" + "；".join(
            f"{a.get('character')}：{a.get('start')}→{a.get('end')}"
            + (f"（性格：{a.get('personality')}）" if a.get("personality") else "")
            for a in arcs[:8]
        ))
    vols = content.get("volumes") or []
    if vols:
        parts.append(
            "分卷：" + "；".join(
                f"第{v.get('no')}卷《{v.get('name')}》{v.get('focus')}"
                f"{('（' + str(v.get('word_count')) + '）') if v.get('word_count') else ''}"
                for v in vols[:8]
            )
        )
    fw = content.get("foreshadowing_plan") or []
    if fw:
        parts.append("伏笔计划：" + "；".join(f"{f.get('desc')}（埋第{f.get('plant_chapter')}章→揭第{f.get('payoff_chapter')}章）" for f in fw[:8]))
    subs = content.get("subplots") or []
    if subs:
        parts.append("长线支线：" + "；".join(subs[:8]))
    tl = content.get("timeline") or []
    if tl:
        tl_bits = []
        for e in tl[:20]:
            if not isinstance(e, dict):
                continue
            label = str(e.get("period") or "")
            if not label and isinstance(e.get("year"), int):
                label = f"{e['year']}年"
            tl_bits.append(f"{label or '（时间不明）'} {e.get('entity')} {e.get('event')}")
        if tl_bits:
            parts.append(
                "时间线硬事实（数据化定档，写作/评价不得与其中任何一条矛盾）："
                + "；".join(tl_bits)
            )
    notes = content.get("notes") or []
    if notes:
        parts.append("保留要点（作者原话，须遵循）：" + "；".join(notes[:12]))
    return "\n".join(parts)


def format_settings_for_prompt(settings: list[Setting]) -> str:
    """把设定条目渲染为提示词文本：宪法/动态文本分条，其余字段与实体卡分行展示。"""
    if not settings:
        return "（暂无设定条目）"
    lines = []
    for s in settings:
        st = s.structured or {}
        con = (st.get("constitution_text") or "").strip()
        dyn = (st.get("dynamic_text") or "").strip()
        rank = _rank_tag(s)
        if con or dyn:
            if con:
                lines.append(f"- [{s.type}]{rank}[宪法] {s.name}（不可变）：{con}")
            if dyn:
                lines.append(f"- [{s.type}]{rank} {s.name}（随剧情演变）：{dyn}")
        else:
            mark = "[宪法]" if s.is_constitution else ""
            lines.append(f"- [{s.type}]{rank}{mark} {s.name}：{s.description or ''}")
            # 其余结构化字段：实体卡的硬事实/锁定细节单独成行渲染（见下），避免整块 dict 混排
            rest = {k: v for k, v in st.items() if k not in ("hard_facts", "locked_details")}
            if rest:
                lines.append(f"    {rest}")
        lines.extend(_format_entity_card(st))
    return "\n".join(lines)


def _format_entity_card(st: dict) -> list[str]:
    """把实体卡的「硬事实 / 锁定细节」渲染为独立行（硬事实是确定性核对的依据）。

    - hard_facts：不可变可核对事实（如 成立时间=2000年、人员规模=3人），写作/评价不得矛盾；
    - locked_details：正文「首次提及即冻结」的具体细节（提取师回写），后续章节不得推翻。
    """
    out: list[str] = []
    hard = st.get("hard_facts")
    if isinstance(hard, dict) and hard:
        bits = []
        for k, v in hard.items():
            if v in (None, ""):
                continue
            bits.append(f"{k}={v}")
        if bits:
            out.append(f"    [硬事实·不可变，写作不得与之矛盾] {'；'.join(bits)}")
    locked = st.get("locked_details")
    if isinstance(locked, list) and locked:
        out.append("    [已冻结细节·正文确立后锁定，不得推翻] " + "；".join(str(x) for x in locked))
    return out


ROLE_RANK_LABEL = {
    "protagonist": "主角",
    "major": "重要配角",
    "minor": "次要配角",
    "extra": "龙套/炮灰",
}


def _rank_tag(s: Setting) -> str:
    """角色等级标记（如 [主角]）；非角色类型返回空串。"""
    if s.type != "character":
        return ""
    r = str((s.structured or {}).get("role_rank") or "").strip()
    return f"[{ROLE_RANK_LABEL.get(r, r)}]" if r else ""


# ---------------------------------------------------------------------------
# token 预算器：按模型 context_window 动态装配，超窗时按组件优先级从低到高剔除。
# 硬约束（priority >= PRIORITY_REQUIRED）永不剔除；被剔除的组件记入 truncated_components。
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """粗略估算 token 数（中英混排，字符加权；用于预算裁剪，非精确计费）。

    中文约 1.5~2 字符/token，英文约 4 字符/token。为「宁可多裁不可超窗」，
    估算取偏保守值（略高估），给模型上下文留余量。
    """
    if not text:
        return 0
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other = len(text) - cjk
    return max(1, int(cjk / 1.5 + other / 4))


def assemble_components(components) -> str:
    """把组件块按原顺序拼成 user_content（块间空行分隔）。"""
    return "\n\n".join(c.content for c in components)


def apply_token_budget(ctx, context_window: int, *, output_reserve: int | None = None) -> int:
    """按 context_window 裁剪 ctx.components（就地），超窗时剔除低优先级组件。

    返回被剔除的组件数量。context_window 为 0/None 时跳过（不裁剪）。
    system 消息不计入 user 预算，但输出预留要留足，避免模型「输入挤满、输出被截」。
    """
    if not context_window or not ctx.components:
        return 0
    reserve = output_reserve or ctx.max_tokens or DEFAULT_OUTPUT_RESERVE
    budget = max(1000, int(context_window) - int(reserve))
    system_tokens = estimate_tokens(ctx.system_prompt)

    # 估算当前总量：system + 全部组件
    total = system_tokens + sum(estimate_tokens(c.content) for c in ctx.components)
    if total <= budget:
        return 0

    # 从低优先级到高优先级剔除，直到不超窗；硬约束（priority >= PRIORITY_REQUIRED）不剔
    removed = 0
    # 稳定排序：低优先级在前
    order = sorted(range(len(ctx.components)), key=lambda i: ctx.components[i].priority)
    for i in order:
        if total <= budget:
            break
        c = ctx.components[i]
        if c.priority >= 100:
            continue  # 硬约束永不剔除
        total -= estimate_tokens(c.content)
        ctx.truncated_components.append(c.key)
        ctx.components[i] = None  # 先标记，避免索引错位
        removed += 1
    ctx.components = [c for c in ctx.components if c is not None]
    return removed
