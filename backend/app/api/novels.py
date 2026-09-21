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
    """设定条目列表；GET 支持 ?type=&q=（M1 起 q 走语义检索，M0 为名称/描述 LIKE）。

    版本过滤（与 agent 上下文 get_settings_snapshot 一致）：
    - source="blueprint"：只显示当前生效蓝图的导入设定，其余版本隐藏（可切回恢复）；
    - source="outline"：大纲注入设定记录来源版本（outline_ids，可跨章多值），
      只要任一来源版本仍是「该章当前批准版」即显示，全部来源不再批准才隐藏。
    手动/批量设定（batch/manual）始终显示。
    """
    from app.db.models import Blueprint, Outline

    # 当前生效蓝图的 id（无则 None → 蓝图设定整体隐藏）
    active_bp_id = db.execute(
        select(Blueprint.id)
        .where(Blueprint.novel_id == novel_id, Blueprint.status == "active")
        .order_by(Blueprint.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    # 各章当前批准版大纲 id（无则空集 → outline 注入设定整体隐藏）；与 outline_ids 均按字符串比较
    approved_outline_ids = {
        str(x)
        for x in db.execute(
            select(Outline.id).where(Outline.novel_id == novel_id, Outline.status == "approved")
        ).scalars()
    }

    stmt = select(Setting).where(Setting.novel_id == novel_id, Setting.deleted_at.is_(None))
    if type:
        stmt = stmt.where(Setting.type == type)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Setting.name.like(like) | Setting.description.like(like))
    rows = db.execute(stmt.order_by(Setting.type, Setting.name)).scalars().all()
    rows = [
        s
        for s in rows
        if s.source != "blueprint" or (s.blueprint_id is not None and s.blueprint_id == active_bp_id)
    ]
    rows = [
        s
        for s in rows
        if s.source != "outline" or (s.outline_ids and any(o in approved_outline_ids for o in s.outline_ids))
    ]
    return rows


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
