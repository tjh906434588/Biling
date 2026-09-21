"""章节大纲 API：列表（每章一条当前生效版）/ 批准激活 / 版本历史。"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.db.models import Chapter, Novel, Outline
from app.db.session import get_db
from app.schemas.ledger import OutlineRead

router = APIRouter(prefix="/api/novels", tags=["outlines"])


def _pick_current(rows: list[Outline]) -> list[Outline]:
    """同一章可能有多个版本（轻量历史版本）：列表只返回每章「当前生效」版。

    优先级：批准版（同章最多一个）> 最新草稿（version_no 最大）。按章号升序。
    """
    by_chapter: dict[int, Outline] = {}
    for r in rows:
        cur = by_chapter.get(r.chapter_no)
        if cur is None:
            by_chapter[r.chapter_no] = r
            continue
        # 已批准的胜出；都没有批准时取版本号更大的
        cur_approved = cur.status == "approved"
        new_approved = r.status == "approved"
        if new_approved and not cur_approved:
            by_chapter[r.chapter_no] = r
        elif new_approved == cur_approved and r.version_no > cur.version_no:
            by_chapter[r.chapter_no] = r
    return sorted(by_chapter.values(), key=lambda r: r.chapter_no)


@router.get("/{novel_id}/outlines", response_model=list[OutlineRead])
def list_outlines(
    novel_id: uuid.UUID,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    stmt = select(Outline).where(Outline.novel_id == novel_id)
    if status:
        # 指定状态（如 approved）：原样返回（同章最多一个 approved），按章号+版本排序
        stmt = stmt.where(Outline.status == status).order_by(Outline.chapter_no, Outline.version_no)
        return db.execute(stmt).scalars().all()
    rows = db.execute(stmt.order_by(Outline.chapter_no, Outline.version_no)).scalars().all()
    return _pick_current(list(rows))


@router.get("/{novel_id}/outlines/{outline_id}/versions", response_model=list[OutlineRead])
def list_outline_versions(
    novel_id: uuid.UUID,
    outline_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    """返回同一章的全部版本（历史版本切换用），按版本号升序。"""
    outline = db.get(Outline, outline_id)
    if outline is None or outline.novel_id != novel_id:
        raise HTTPException(404, "大纲不存在")
    rows = db.execute(
        select(Outline)
        .where(Outline.novel_id == novel_id, Outline.chapter_no == outline.chapter_no)
        .order_by(Outline.version_no)
    ).scalars().all()
    return list(rows)


class OutlineHasChapter(BaseModel):
    """该章正文是否「不是基于本大纲版本」生成的（批准新版本时的二次确认依据）。"""
    chapter_no: int
    has_chapter: bool


@router.get("/{novel_id}/outlines/{outline_id}/has-chapter", response_model=OutlineHasChapter)
def outline_has_chapter(novel_id: uuid.UUID, outline_id: uuid.UUID, db: Session = Depends(get_db)):
    """批准某大纲版本前判断是否需要二次确认。

    口径（版本级关联）：不是看「目标版本」本身，而是看该章已有的正文是否基于
    「别的版本」生成——正文 outline_id 指向其他版本，或正文是自由稿（outline_id 为空）。
    这种情况下批准/切换此版本，已生成正文不会自动重写，二者可能不一致，需用户自行决定。
    若正文正是基于本版本生成（outline_id == 本版本），则无需提示。
    """
    outline = db.get(Outline, outline_id)
    if outline is None or outline.novel_id != novel_id:
        raise HTTPException(404, "大纲不存在")
    ch = db.execute(
        select(Chapter).where(
            Chapter.novel_id == novel_id,
            Chapter.chapter_no == outline.chapter_no,
        )
    ).scalars().first()
    has_chapter = bool(ch is not None and ch.outline_id != outline.id)
    return OutlineHasChapter(chapter_no=outline.chapter_no, has_chapter=has_chapter)


@router.post("/{novel_id}/outlines/{outline_id}/approve", response_model=OutlineRead)
def approve_outline(novel_id: uuid.UUID, outline_id: uuid.UUID, db: Session = Depends(get_db)):
    """大纲批准激活：指定版本 approved，同章其他版本全部降回 draft。

    版本语义：同章最多一个 approved（下游唯一依据），批准即「切换到此版本」。
    """
    outline = db.get(Outline, outline_id)
    if outline is None or outline.novel_id != novel_id:
        raise HTTPException(404, "大纲不存在")
    # 同章其他版本全部降回 draft，保证批准版唯一
    db.query(Outline).filter(
        Outline.novel_id == novel_id,
        Outline.chapter_no == outline.chapter_no,
        Outline.id != outline_id,
        Outline.status == "approved",
    ).update({"status": "draft"})
    outline.status = "approved"
    db.commit()
    db.refresh(outline)
    return outline
