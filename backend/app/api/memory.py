"""记忆审查 API（M4）：体检记忆层一致性（伏笔超期/悬置、角色状态链、设定别名合并状况）。

仅体检展示，不阻断写作；对照 §6 记忆层 as-of 语义。
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Chapter, Novel, PlotLedger, Setting, StoryState
from app.db.session import get_db

router = APIRouter(prefix="/api/novels", tags=["memory"])


@router.get("/{novel_id}/memory-review")
def memory_review(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")

    progress = db.execute(
        select(func.max(Chapter.chapter_no)).where(Chapter.novel_id == novel_id)
    ).scalar() or 0

    # 1. 超期伏笔：open 且已写到 target_reveal_chapter 仍未回收
    overdue = db.execute(
        select(PlotLedger).where(
            PlotLedger.novel_id == novel_id,
            PlotLedger.status == "open",
            PlotLedger.target_reveal_chapter.is_not(None),
            PlotLedger.target_reveal_chapter <= progress,
        ).order_by(PlotLedger.urgency.desc().nullslast())
    ).scalars().all()

    # 2. 悬置过久的 open 钩子：引入 >=5 章且未超期但久未回收
    stale = db.execute(
        select(PlotLedger).where(
            PlotLedger.novel_id == novel_id,
            PlotLedger.status == "open",
            PlotLedger.chapter_introduced.is_not(None),
            PlotLedger.chapter_introduced <= progress - 5,
        ).order_by(PlotLedger.chapter_introduced)
    ).scalars().all()

    # 3. 角色状态链：每角色最新 character_state（as-of 最新章）
    states = db.execute(
        select(StoryState)
        .where(StoryState.novel_id == novel_id, StoryState.character_states.is_not(None))
        .order_by(StoryState.chapter_no.desc())
    ).scalars().all()
    character_states: dict[str, dict] = {}
    for st in states:
        for cs in st.character_states or []:
            name = cs.get("character") if isinstance(cs, dict) else None
            if name and name not in character_states:
                character_states[name] = {"state": cs.get("state"), "chapter_no": st.chapter_no, "confidence": cs.get("confidence")}

    # 4. 最新章未解决钩子
    latest = states[0] if states else None
    unresolved_hooks = latest.unresolved_hooks if latest else []

    # 5. 设定别名/合并状况（M2 别名合并）
    alias_count = db.execute(
        select(func.count(Setting.id)).where(
            Setting.novel_id == novel_id, Setting.aliases.is_not(None)
        )
    ).scalar() or 0
    merged_count = db.execute(
        select(func.count(Setting.id)).where(
            Setting.novel_id == novel_id, Setting.merged_into_id.is_not(None)
        )
    ).scalar() or 0

    total_open = len(overdue) + len([s for s in stale if s.id not in {o.id for o in overdue}])
    issues: list[str] = []
    # 超期伏笔在账本页面已有专页展示与预警横幅，此处不再重复提示
    if not character_states and progress > 0:
        issues.append("已有章节但缺少角色状态链（建议对已完成章节跑提取师）")

    return {
        "progress_chapter": progress,
        "overdue_foreshadowing": [
            {"id": str(o.id), "description": o.description, "target_reveal_chapter": o.target_reveal_chapter, "urgency": o.urgency}
            for o in overdue
        ],
        "stale_open_hooks": [
            {"id": str(s.id), "description": s.description, "chapter_introduced": s.chapter_introduced, "since": progress - (s.chapter_introduced or progress)}
            for s in stale
        ],
        "character_states": character_states,
        "latest_unresolved_hooks": unresolved_hooks,
        "setting_aliases": {"with_aliases": alias_count, "merged_duplicates": merged_count},
        "total_open": total_open,
        "issues": issues,
        "healthy": not issues,
    }
