"""小说项目 + 设定条目路由。"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Novel, Setting
from app.db.session import get_db
from app.schemas.novel import (
    NovelCreate,
    NovelRead,
    NovelUpdate,
    SettingCreate,
    SettingRead,
    SettingUpdate,
)

router = APIRouter(prefix="/api/novels", tags=["novels"])


@router.post("", response_model=NovelRead)
def create_novel(payload: NovelCreate, db: Session = Depends(get_db)):
    novel = Novel(title=payload.title, premise=payload.premise)
    db.add(novel)
    db.commit()
    db.refresh(novel)
    return novel


@router.get("", response_model=list[NovelRead])
def list_novels(db: Session = Depends(get_db)):
    return db.execute(select(Novel).order_by(Novel.updated_at.desc())).scalars().all()


@router.get("/{novel_id}", response_model=NovelRead)
def get_novel(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    return novel


@router.patch("/{novel_id}", response_model=NovelRead)
def update_novel(novel_id: uuid.UUID, payload: NovelUpdate, db: Session = Depends(get_db)):
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(novel, k, v)
    db.commit()
    db.refresh(novel)
    return novel


@router.get("/{novel_id}/settings", response_model=list[SettingRead])
def list_settings(
    novel_id: uuid.UUID,
    type: Optional[str] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """设定条目列表；GET 支持 ?type=&q=（M1 起 q 走语义检索，M0 为名称/描述 LIKE）。"""
    stmt = select(Setting).where(Setting.novel_id == novel_id, Setting.deleted_at.is_(None))
    if type:
        stmt = stmt.where(Setting.type == type)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Setting.name.like(like) | Setting.description.like(like))
    return db.execute(stmt.order_by(Setting.type, Setting.name)).scalars().all()


@router.post("/{novel_id}/settings", response_model=SettingRead)
def create_setting(novel_id: uuid.UUID, payload: SettingCreate, db: Session = Depends(get_db)):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    setting = Setting(novel_id=novel_id, **payload.model_dump())
    db.add(setting)
    db.commit()
    db.refresh(setting)
    return setting


@router.patch("/{novel_id}/settings/{setting_id}", response_model=SettingRead)
def update_setting(
    novel_id: uuid.UUID, setting_id: uuid.UUID, payload: SettingUpdate, db: Session = Depends(get_db)
):
    setting = db.get(Setting, setting_id)
    if setting is None or setting.novel_id != novel_id or setting.deleted_at is not None:
        raise HTTPException(404, "设定不存在")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(setting, k, v)
    db.commit()
    db.refresh(setting)
    return setting


@router.delete("/{novel_id}/settings/{setting_id}", status_code=204)
def delete_setting(novel_id: uuid.UUID, setting_id: uuid.UUID, db: Session = Depends(get_db)):
    """软删除：deleted_at 标记，列表/检索自动过滤。"""
    setting = db.get(Setting, setting_id)
    if setting is None or setting.novel_id != novel_id or setting.deleted_at is not None:
        raise HTTPException(404, "设定不存在")
    from datetime import datetime, timezone

    setting.deleted_at = datetime.now(timezone.utc)
    db.commit()
