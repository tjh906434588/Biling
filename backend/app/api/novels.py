"""小说项目 + 设定条目路由。"""
import re
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
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
from app.services.novel_backup import build_zip, restore_novel_from_zip

router = APIRouter(prefix="/api/novels", tags=["novels"])

# 导入备份文件大小上限（整本书含全部版本正文，给足余量）
MAX_IMPORT_BYTES = 200 * 1024 * 1024


@router.post("", response_model=NovelRead)
def create_novel(payload: NovelCreate, db: Session = Depends(get_db)):
    """新建小说项目（标题/一句话梗概/背景类型/题材）。"""
    novel = Novel(
        title=payload.title,
        premise=payload.premise,
        background_type=payload.background_type,
        genres=payload.genres or [],
    )
    db.add(novel)
    db.commit()
    db.refresh(novel)
    return novel


@router.get("", response_model=list[NovelRead])
def list_novels(db: Session = Depends(get_db)):
    """小说项目列表（按最近更新倒序）。"""
    return db.execute(select(Novel).order_by(Novel.updated_at.desc())).scalars().all()


@router.get("/{novel_id}", response_model=NovelRead)
def get_novel(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """单个小说项目详情（含风格指令 style_directive 等设置）。"""
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    return novel


@router.patch("/{novel_id}", response_model=NovelRead)
def update_novel(novel_id: uuid.UUID, payload: NovelUpdate, db: Session = Depends(get_db)):
    """部分更新小说项目字段（标题/梗概/背景类型/题材/风格指令等）。"""
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(novel, k, v)
    db.commit()
    db.refresh(novel)
    return novel


@router.delete("/{novel_id}", status_code=204)
def delete_novel(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """删除小说及其全部关联数据。

    SQLite 未开启外键级联，这里按依赖顺序显式清理所有关联表：
    直接带 novel_id 的表（任务/评价/记忆层/图谱/概念卡/风格/设定/账本）→
    章节版本（经章节）→ 章节 → 大纲 → 蓝图及文风 → 该小说写作指令（prompts scope）→ 小说本体。
    """
    from sqlalchemy import delete as sa_delete

    from app.db.models import (
        AgentTask,
        Blueprint,
        BlueprintStyle,
        Chapter,
        ChapterVersion,
        ConceptCard,
        EntityRelation,
        Outline,
        PlotLedger,
        PromptTemplate,
        QualityReview,
        Setting,
        StoryState,
        StyleProfile,
    )

    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")

    chapter_ids = db.execute(
        select(Chapter.id).where(Chapter.novel_id == novel_id)
    ).scalars().all()

    db.execute(sa_delete(AgentTask).where(AgentTask.novel_id == novel_id))
    db.execute(sa_delete(QualityReview).where(QualityReview.novel_id == novel_id))
    db.execute(sa_delete(StoryState).where(StoryState.novel_id == novel_id))
    db.execute(sa_delete(EntityRelation).where(EntityRelation.novel_id == novel_id))
    db.execute(sa_delete(ConceptCard).where(ConceptCard.novel_id == novel_id))
    db.execute(sa_delete(StyleProfile).where(StyleProfile.novel_id == novel_id))
    db.execute(sa_delete(Setting).where(Setting.novel_id == novel_id))
    db.execute(sa_delete(PlotLedger).where(PlotLedger.novel_id == novel_id))
    # 章节版本（无 novel_id，经章节关联）
    if chapter_ids:
        db.execute(sa_delete(ChapterVersion).where(ChapterVersion.chapter_id.in_(chapter_ids)))
    db.execute(sa_delete(Chapter).where(Chapter.novel_id == novel_id))
    # 大纲（引用蓝图，先于蓝图删除）
    db.execute(sa_delete(Outline).where(Outline.novel_id == novel_id))
    # 蓝图及其按版本存储的文风
    db.execute(sa_delete(BlueprintStyle).where(BlueprintStyle.novel_id == novel_id))
    db.execute(sa_delete(Blueprint).where(Blueprint.novel_id == novel_id))
    # 该小说的写作指令（prompts scope=novel:{id}）
    db.execute(sa_delete(PromptTemplate).where(PromptTemplate.scope == f"novel:{novel_id}"))

    db.delete(novel)
    db.commit()


@router.get("/{novel_id}/settings", response_model=list[SettingRead])
def list_settings(
    novel_id: uuid.UUID,
    type: Optional[str] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """设定条目列表；GET 支持 ?type=&q=（q 为名称/描述 LIKE 检索）。

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
    """新建设定条目（手动录入，source=manual）。"""
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
    """部分更新设定条目（名称/类型/描述/结构化/别名等，含别名合并维护）。"""
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


@router.get("/{novel_id}/export")
def export_novel(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """导出整本书：打包全部业务表数据为 zip（换电脑 / 备份用）。"""
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    zip_bytes = build_zip(db, novel_id, novel.title)
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", novel.title) or "book"
    filename = f"biling-{safe}-{datetime.now(timezone.utc):%Y%m%d}.zip"
    return Response(
        zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.post("/import")
def import_novel(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """导入整本书：还原为一本内容完全相同的新书，返回新书信息（前端可跳转续写）。"""
    payload = file.file.read()
    if len(payload) > MAX_IMPORT_BYTES:
        raise HTTPException(413, f"文件过大（上限 {MAX_IMPORT_BYTES // (1024 * 1024)}MB）")
    try:
        new_id = restore_novel_from_zip(db, payload)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    novel = db.get(Novel, new_id)
    return NovelRead.model_validate(novel)
