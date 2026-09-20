"""蓝图 API：列表 / active / 激活 / 归档 / 详情 / 导入。"""
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Blueprint, Novel
from app.db.session import get_db
from app.schemas.blueprint import BlueprintCheckRequest, BlueprintRead, BlueprintUpdateIn
from app.services.file_import import MAX_IMPORT_BYTES, extract_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/novels", tags=["blueprints"])


def _get_blueprint(novel_id: uuid.UUID, blueprint_id: uuid.UUID, db: Session) -> Blueprint:
    bp = db.get(Blueprint, blueprint_id)
    if bp is None or bp.novel_id != novel_id:
        raise HTTPException(404, "蓝图不存在")
    return bp


@router.get("/{novel_id}/blueprints", response_model=list[BlueprintRead])
def list_blueprints(
    novel_id: uuid.UUID,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    stmt = select(Blueprint).where(Blueprint.novel_id == novel_id)
    if status:
        stmt = stmt.where(Blueprint.status == status)
    return db.execute(stmt.order_by(Blueprint.version.desc())).scalars().all()


@router.get("/{novel_id}/blueprints/active", response_model=Optional[BlueprintRead])
def get_active_blueprint(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """当前生效蓝图（无则 200 + null）。"""
    return db.execute(
        select(Blueprint)
        .where(Blueprint.novel_id == novel_id, Blueprint.status == "active")
        .order_by(Blueprint.version.desc())
        .limit(1)
    ).scalar_one_or_none()


@router.get("/{novel_id}/blueprints/{blueprint_id}", response_model=BlueprintRead)
def get_blueprint(novel_id: uuid.UUID, blueprint_id: uuid.UUID, db: Session = Depends(get_db)):
    return _get_blueprint(novel_id, blueprint_id, db)


@router.post("/{novel_id}/blueprints/{blueprint_id}/activate", response_model=BlueprintRead)
def activate_blueprint(novel_id: uuid.UUID, blueprint_id: uuid.UUID, db: Session = Depends(get_db)):
    """激活蓝图：旧 active 置 inactive，本蓝图置 active（全书唯一 active）。

    同时把全局文风 style_directive 同步为该蓝图的文风（无则清空），
    设定库的"切换"由前端按生效蓝图过滤展示。
    """
    from app.services.pipeline import sync_active_blueprint_style

    bp = _get_blueprint(novel_id, blueprint_id, db)
    if bp.status == "active":
        db.refresh(bp)
        return bp
    # 旧 active → inactive（不限状态，任何未生效蓝图都能激活）
    db.execute(
        Blueprint.__table__.update()
        .where(Blueprint.novel_id == novel_id, Blueprint.status == "active")
        .values(status="inactive")
    )
    bp.status = "active"
    db.commit()
    # 全局文风跟随生效蓝图：有该蓝图提炼的文风就用它，否则清空（手动文风不受影响）
    sync_active_blueprint_style(db, novel_id, blueprint_id)
    db.refresh(bp)
    return bp


@router.post("/{novel_id}/blueprints/import")
async def import_blueprint_file(
    novel_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """导入外部生成的全书大纲（Word/PDF/Markdown）：提取文本返回给前端预览。

    仅提取文字、不落库；由前端「识别为蓝图」走蓝图师流式规范化后存为新版本。
    """
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    data = await file.read()
    if not data:
        raise HTTPException(400, "文件为空")
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(413, f"文件过大（上限 {MAX_IMPORT_BYTES // (1024 * 1024)}MB）")
    try:
        text = extract_text(file.filename or "", data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    text = text.strip()
    if not text:
        raise HTTPException(422, "未能从文件中提取到文字内容，请检查文件是否损坏或为扫描图片版 PDF")
    return {
        "filename": file.filename or "",
        "text": text,
        "text_length": len(text),
    }


@router.post("/{novel_id}/blueprints/outline-check")
async def check_blueprint_outline(
    novel_id: uuid.UUID,
    payload: Optional[BlueprintCheckRequest] = None,
    db: Session = Depends(get_db),
):
    """导入大纲后的骨架语义校验：判断文档是否真实覆盖四件套骨架（体量/分卷/人物/主线支线）。

    LLM 语义判断（source=llm），失败回退关键词扫描（source=deterministic）；
    结果用于前端生成前的「建议补全」提示（可跳过直接生成）。
    """
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    text = (payload.source_doc if payload else None) or ""
    text = text.strip()
    if not text:
        raise HTTPException(400, "缺少大纲文本，无法校验")
    from app.services.outline_checker import run_outline_check

    try:
        return await run_outline_check(db, novel_id, text)
    except Exception as e:
        logger.exception("novel=%s 大纲骨架校验失败", novel_id)
        raise HTTPException(500, f"大纲骨架校验失败：{e}")


@router.post("/{novel_id}/blueprints/{blueprint_id}/check")
async def check_blueprint_import(
    novel_id: uuid.UUID,
    blueprint_id: uuid.UUID,
    payload: Optional[BlueprintCheckRequest] = None,
    db: Session = Depends(get_db),
):
    """导入后校验比对：把该版本生成时用的导入文档与蓝图 content 逐节比对，
    找出"文档有、蓝图没收录/收录不全"的内容（LLM 语义核对，失败回退关键词扫描）。
    """
    from app.services.blueprint_checker import run_blueprint_check

    bp = _get_blueprint(novel_id, blueprint_id, db)
    source_doc = ""
    if payload and payload.source_doc:
        source_doc = payload.source_doc.strip()
    if not source_doc:
        source_doc = (bp.source_doc or "").strip()
    if not source_doc:
        raise HTTPException(
            400,
            "该蓝图没有关联的导入文档，无法比对。请先通过「导入大纲」识别生成蓝图，再执行校验。",
        )
    try:
        return await run_blueprint_check(db, novel_id, bp, source_doc)
    except Exception as e:
        logger.exception("blueprint=%s 校验比对失败", blueprint_id)
        raise HTTPException(500, f"校验比对失败：{e}")


@router.post("/{novel_id}/blueprints/{blueprint_id}/style-extract")
async def extract_blueprint_style(
    novel_id: uuid.UUID,
    blueprint_id: uuid.UUID,
    payload: Optional[BlueprintCheckRequest] = None,
    db: Session = Depends(get_db),
):
    """从该蓝图关联的导入文档中提炼「全局文风描述」候选，供作者确认后写入 style_directive。

    不自动覆盖：返回 {current（现有 style_directive）, candidate（新文档提炼的候选）}，
    由前端展示差异，作者确认后再调 PATCH /novels/{id} 写入。
    """
    from app.agents.registry import get_agent

    bp = _get_blueprint(novel_id, blueprint_id, db)
    source_doc = ""
    if payload and payload.source_doc:
        source_doc = payload.source_doc.strip()
    if not source_doc:
        source_doc = (bp.source_doc or "").strip()
    if not source_doc:
        raise HTTPException(
            400,
            "该蓝图没有关联的导入文档，无法提炼风格。请先通过「导入大纲」识别生成蓝图。",
        )
    novel = db.get(Novel, novel_id)
    try:
        agent = get_agent(db, "style_extractor")
        ctx = agent.build_context(novel_id, {
            "source_doc": source_doc,
            "title": novel.title if novel else None,
        })
        out = ""
        async for piece in agent.run(ctx):
            out += piece
        parsed = agent.parse_output(out)
        return {
            "current": novel.style_directive if novel else None,
            "candidate": parsed.style_directive,
            "doc_name": bp.doc_name,
        }
    except Exception as e:
        logger.exception("blueprint=%s 风格提炼失败", blueprint_id)
        raise HTTPException(500, f"风格提炼失败：{e}")


@router.patch("/{novel_id}/blueprints/{blueprint_id}", response_model=BlueprintRead)
def update_blueprint(
    novel_id: uuid.UUID,
    blueprint_id: uuid.UUID,
    payload: BlueprintUpdateIn,
    db: Session = Depends(get_db),
):
    """部分更新蓝图 content：仅覆盖 payload.content 中出现的键，其余保持不变。

    用于「校验比对」发现缺漏后人工补全（如补充 world_rules / volumes / notes 等）。
    """
    bp = _get_blueprint(novel_id, blueprint_id, db)
    merged = dict(bp.content or {})
    for k, v in (payload.content or {}).items():
        if v is None:
            continue
        merged[k] = v
    bp.content = merged
    db.commit()
    db.refresh(bp)
    return bp


@router.delete("/{novel_id}/blueprints/{blueprint_id}", status_code=204)
def delete_blueprint(novel_id: uuid.UUID, blueprint_id: uuid.UUID, db: Session = Depends(get_db)):
    """删除蓝图版本：仅未生效（inactive）可删；生效中（active）不可删。

    删除时连同该蓝图导入的设定（软删）与按版本存的文风一并清除。
    """
    from datetime import datetime, timezone

    from app.db.models import BlueprintStyle, Setting

    bp = _get_blueprint(novel_id, blueprint_id, db)
    if bp.status == "active":
        raise HTTPException(400, "当前生效中的蓝图不可删除，请先激活其他蓝图")
    now = datetime.now(timezone.utc)
    # 软删该蓝图导入的设定（保留手动/批量设定）
    db.execute(
        Setting.__table__.update()
        .where(Setting.novel_id == novel_id, Setting.blueprint_id == blueprint_id, Setting.deleted_at.is_(None))
        .values(deleted_at=now)
    )
    db.execute(BlueprintStyle.__table__.delete().where(BlueprintStyle.blueprint_id == blueprint_id))
    db.delete(bp)
    db.commit()
