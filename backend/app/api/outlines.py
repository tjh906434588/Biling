"""章节大纲 API：列表 / 批准生效。"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Novel, Outline
from app.db.session import get_db
from app.schemas.ledger import OutlineRead

router = APIRouter(prefix="/api/novels", tags=["outlines"])


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
        stmt = stmt.where(Outline.status == status)
    return db.execute(stmt.order_by(Outline.chapter_no)).scalars().all()


@router.post("/{novel_id}/outlines/{outline_id}/approve", response_model=OutlineRead)
def approve_outline(novel_id: uuid.UUID, outline_id: uuid.UUID, db: Session = Depends(get_db)):
    """大纲批准生效：draft → approved（小说家生成时优先引用 approved 大纲）。"""
    outline = db.get(Outline, outline_id)
    if outline is None or outline.novel_id != novel_id:
        raise HTTPException(404, "大纲不存在")
    outline.status = "approved"
    db.commit()
    db.refresh(outline)
    return outline
