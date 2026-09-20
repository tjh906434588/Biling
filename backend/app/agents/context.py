"""角色上下文装配辅助：从记忆层取数据的最小公共函数（M0 骨架版，M1 起由 token 预算器接管）。"""
import uuid
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Blueprint, Chapter, EntityRelation, Novel, PlotLedger, Setting, StoryState, StyleProfile


def get_novel(db: Session, novel_id: uuid.UUID) -> Optional[Novel]:
    return db.get(Novel, novel_id)


def get_graph_relations_text(db: Session, novel_id: uuid.UUID, limit: int = 60) -> str:
    """实体关系图谱摘要（写作/审稿的一致性对照依据，不含方向性修饰）。"""
    rows = (
        db.execute(
            select(EntityRelation)
            .where(
                EntityRelation.novel_id == novel_id,
                EntityRelation.archived.is_(False),  # 手动标记失效（被取代）的关系不注入
            )
            .order_by(EntityRelation.created_at)
        )
        .scalars()
        .all()
    )
    if not rows:
        return "（图谱暂无关系）"
    # AI 需要当前关系快照：按 (source, relation, target) 三元组去重，每组取最新确立的一条
    # （created_at 升序遍历，后者覆盖前者）。同一对实体可以存在多个**共存**关系
    # （如「A 同事 B」「A 朋友 B」同时成立）——全部注入；而被**取代**的旧关系
    # （如「师徒」→「叛出师门」）由提取师约束不输出，保证注入不含过时关系。
    # 历史演进仍保留在图谱页展示。
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
    """
    from app.db.models import Blueprint

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
    rows = [
        s
        for s in all_rows
        if s.source != "blueprint" or (s.blueprint_id is not None and s.blueprint_id == active_bp_id)
    ]

    def has_constitution(s: Setting) -> bool:
        if s.is_constitution:
            return True
        st = s.structured or {}
        return bool((st.get("constitution_text") or "").strip())

    def sort_key(s: Setting):
        ts = s.updated_at.timestamp() if s.updated_at else 0.0
        return (0 if has_constitution(s) else 1, -ts)

    rows.sort(key=sort_key)
    return rows[:limit]


# 阶段标签（structured.stages 用英文枚举，展示层映射中文）
STAGE_LABELS = {"early": "前期", "middle": "中期", "late": "后期"}


def derive_stage(chapter_no: int, blueprint: dict | None) -> Optional[str]:
    """按当前章节号从蓝图分卷推导所处阶段（早期/中期/后期）。

    以分卷 chapters_range（如 "1-20"）的最后一个结束章作为全书总章数，
    三等分：前 1/3 = 前期，中 1/3 = 中期，后 1/3 = 后期。
    无法推导（无蓝图或无章范围）时返回 None，调用方应跳过阶段过滤。
    """
    if not blueprint or chapter_no <= 0:
        return None
    total = None
    for v in blueprint.get("volumes") or []:
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


def get_recent_story_states(db: Session, novel_id: uuid.UUID, limit: int = 3) -> list[StoryState]:
    return list(
        db.execute(
            select(StoryState)
            .where(StoryState.novel_id == novel_id)
            .order_by(StoryState.chapter_no.desc())
            .limit(limit)
        ).scalars()
    )


def get_recent_chapters(db: Session, novel_id: uuid.UUID, limit: int = 2) -> list[Chapter]:
    return list(
        db.execute(
            select(Chapter)
            .where(Chapter.novel_id == novel_id, Chapter.status == "complete")
            .order_by(Chapter.chapter_no.desc())
            .limit(limit)
        ).scalars()
    )


def get_latest_style_profile(db: Session, novel_id: uuid.UUID) -> Optional[StyleProfile]:
    return db.execute(
        select(StyleProfile)
        .where(StyleProfile.novel_id == novel_id)
        .order_by(StyleProfile.version.desc())
        .limit(1)
    ).scalar_one_or_none()


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
    notes = content.get("notes") or []
    if notes:
        parts.append("保留要点（作者原话，须遵循）：" + "；".join(notes[:12]))
    return "\n".join(parts)


def format_settings_for_prompt(settings: list[Setting]) -> str:
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
            if st:
                lines.append(f"    {st}")
    return "\n".join(lines)


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
