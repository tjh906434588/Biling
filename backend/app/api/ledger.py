"""伏笔账本 API：列表 / 超期视图 / 手动回收与删除。"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Chapter, Novel, PlotLedger
from app.db.session import get_db
from app.schemas.ledger import LedgerRead, LedgerUpdate

router = APIRouter(prefix="/api/novels", tags=["ledger"])


def _get_novel(db: Session, novel_id: uuid.UUID) -> Novel:
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    return novel


def _current_progress(db: Session, novel_id: uuid.UUID) -> int:
    """当前已写到的最大章节号（用于超期判定）。"""
    return db.execute(
        select(func.max(Chapter.chapter_no)).where(Chapter.novel_id == novel_id)
    ).scalar() or 0


def _to_read(row: PlotLedger, progress: int) -> LedgerRead:
    r = LedgerRead.model_validate(row)
    r.overdue = (
        row.status == "open"
        and row.target_reveal_chapter is not None
        and row.target_reveal_chapter <= progress  # 已写到/超过目标揭示章仍未回收
    )
    r.stale = (
        row.status == "open"
        and row.chapter_introduced is not None
        and row.chapter_introduced <= progress - 5  # 引入 >=5 章仍未回收，久未处理
    )
    return r


@router.get("/{novel_id}/ledger", response_model=list[LedgerRead])
def list_ledger(
    novel_id: uuid.UUID,
    status: Optional[str] = None,
    item_type: Optional[str] = None,
    overdue_only: Optional[bool] = False,
    db: Session = Depends(get_db),
):
    """账本列表：?status=open&item_type=setup&overdue_only=true"""
    _get_novel(db, novel_id)
    stmt = select(PlotLedger).where(PlotLedger.novel_id == novel_id)
    if status:
        stmt = stmt.where(PlotLedger.status == status)
    if item_type:
        stmt = stmt.where(PlotLedger.item_type == item_type)
    rows = db.execute(stmt.order_by(PlotLedger.status, PlotLedger.urgency.desc().nulls_last())).scalars().all()
    progress = _current_progress(db, novel_id)
    result = [_to_read(r, progress) for r in rows]
    if overdue_only:
        result = [r for r in result if r.overdue]
    return result


@router.get("/{novel_id}/ledger/overdue", response_model=list[LedgerRead])
def list_overdue(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """超期视图：open 且超过 target_reveal_chapter 尚未回收的伏笔。"""
    return list_ledger(novel_id, status="open", overdue_only=True, db=db)


@router.patch("/{novel_id}/ledger/{item_id}", response_model=LedgerRead)
def update_ledger(
    novel_id: uuid.UUID, item_id: uuid.UUID, payload: LedgerUpdate, db: Session = Depends(get_db)
):
    row = db.get(PlotLedger, item_id)
    if row is None or row.novel_id != novel_id:
        raise HTTPException(404, "账本条目不存在")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    # 置 closed 时记录回收章节
    if payload.status == "closed" and row.chapter_resolved is None:
        row.chapter_resolved = _current_progress(db, novel_id)
    db.commit()
    db.refresh(row)
    return _to_read(row, _current_progress(db, novel_id))


@router.delete("/{novel_id}/ledger/{item_id}", status_code=204)
def delete_ledger(novel_id: uuid.UUID, item_id: uuid.UUID, db: Session = Depends(get_db)):
    """手动误入的条目硬删；大纲师/提取师登记的保留。"""
    row = db.get(PlotLedger, item_id)
    if row is None or row.novel_id != novel_id:
        raise HTTPException(404, "账本条目不存在")
    db.delete(row)
    db.commit()
