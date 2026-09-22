"""蓝图 API：列表 / active / 激活 / 归档 / 详情 / 导入。"""
import asyncio
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AgentTask, Blueprint, Novel
from app.db.session import SessionLocal, get_db
from app.schemas.blueprint import BlueprintCheckRequest, BlueprintRead, BlueprintUpdateIn
from app.services.file_import import MAX_IMPORT_BYTES, extract_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/novels", tags=["blueprints"])

# 激活任务的 agent 标记：仅用于 agent_tasks 持久化「激活中」状态（不注册进 agents.REGISTRY）
AGENT_ACTIVATION = "blueprint_activation"


def _iso_utc(dt) -> str | None:
    """数据库 DateTime 由 SQLite CURRENT_TIMESTAMP 写入，为 UTC 且无时区标记；序列化时补 Z。"""
    return dt.isoformat() + "Z" if dt else None


def _finish_activation(
    db: Session, task_id: uuid.UUID, *, status: str, msg: str | None = None, error: str | None = None
) -> None:
    """后台激活结束时更新 agent_tasks 记录状态（供前端刷新/切页后轮询收尾）。"""
    t = db.get(AgentTask, task_id)
    if t is None:
        return
    t.status = status
    if msg is not None:
        t.msg = msg
    if error is not None:
        t.error = error
    db.commit()


def _get_blueprint(novel_id: uuid.UUID, blueprint_id: uuid.UUID, db: Session) -> Blueprint:
    bp = db.get(Blueprint, blueprint_id)
    if bp is None or bp.novel_id != novel_id:
        raise HTTPException(404, "蓝图不存在")
    return bp


async def _run_blueprint_injection(
    db: Session, novel_id: uuid.UUID, blueprint_id: uuid.UUID
) -> Optional[str]:
    """执行激活前的注入：设定抽取 + 文风提炼（导入模式且该版本尚未抽取过）。

    已注入过的版本（has_settings / has_style 命中）直接复用对应版本数据，不重复调 AI；
    抽取失败不阻断激活（蓝图仍生效），返回 extract_warning（无则 None）供前端提示。
    """
    from app.db.models import BlueprintStyle, Setting
    from app.services.pipeline import _apply_style_from_import, _extract_settings_from_import

    bp = db.get(Blueprint, blueprint_id)
    if bp is None:
        return None
    source_doc = (bp.source_doc or "").strip()
    if not source_doc:
        return None

    missing = []
    has_settings = db.execute(
        select(Setting.id).where(
            Setting.novel_id == novel_id,
            Setting.blueprint_id == blueprint_id,
            Setting.deleted_at.is_(None),
        ).limit(1)
    ).scalar_one_or_none() is not None
    if not has_settings:
        await _extract_settings_from_import(
            db, novel_id, {"import_source": source_doc, "doc_name": bp.doc_name}, blueprint_id
        )
        # 抽取失败（无 AI/超时/没解析出条目）时设定库仍无该版本条目，需提示
        if db.execute(
            select(Setting.id).where(
                Setting.novel_id == novel_id,
                Setting.blueprint_id == blueprint_id,
                Setting.deleted_at.is_(None),
            ).limit(1)
        ).scalar_one_or_none() is None:
            missing.append("设定")
    has_style = db.execute(
        select(BlueprintStyle.id).where(BlueprintStyle.blueprint_id == blueprint_id).limit(1)
    ).scalar_one_or_none() is not None
    if not has_style:
        style_result = await _apply_style_from_import(db, novel_id, {"import_source": source_doc}, blueprint_id)
        if style_result.get("action") == "error":
            missing.append("文风")

    if missing:
        return (
            f"蓝图已生效，但{'、'.join(missing)}抽取未成功（可能未配置 AI 模型）。"
            "可在设定/文风页手动补充，或重新激活该蓝图触发重试。"
        )
    return None


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


@router.get("/{novel_id}/blueprints/activation")
def blueprint_activation_status(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """查询该小说最近一次「蓝图激活」任务：页面刷新/切页后前端据此恢复「激活中…」按钮状态。

    - running=true：后台仍在激活，按钮保持「激活中…」（只有成功/失败才退出）；
    - task：最近一次激活任务（含 blueprint_id / version / warning / error），供完成时展示结果。
    """
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    task = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id, AgentTask.agent == AGENT_ACTIVATION)
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if task is None:
        return {"running": False, "task": None}
    params = task.params or {}
    return {
        "running": task.status == "running",
        "task": {
            "id": str(task.id),
            "blueprint_id": params.get("blueprint_id"),
            "version": params.get("version"),
            "status": task.status,
            "msg": task.msg,
            "error": task.error,
            "warning": params.get("warning"),
            "started_at": _iso_utc(task.created_at),
            "updated_at": _iso_utc(task.updated_at),
        },
    }


@router.get("/{novel_id}/blueprints/{blueprint_id}", response_model=BlueprintRead)
def get_blueprint(novel_id: uuid.UUID, blueprint_id: uuid.UUID, db: Session = Depends(get_db)):
    return _get_blueprint(novel_id, blueprint_id, db)


@router.post("/{novel_id}/blueprints/{blueprint_id}/activate")
async def activate_blueprint(novel_id: uuid.UUID, blueprint_id: uuid.UUID, db: Session = Depends(get_db)):
    """激活蓝图：旧 active 置 inactive，本蓝图置 active（全书唯一 active）。

    生效即注入：若该版本为「导入模式」（有 source_doc）且尚未抽取过设定/文风，
    后台同步触发 setting_extractor + style_extractor（各还要调一次 LLM，激活按钮保持
    「激活中…」直到完成）——保证「设为生效中」成功即意味着设定与文风已注入。

    激活从请求生命周期解耦为后台任务（agent_tasks，agent=blueprint_activation）：
    - 请求立即返回（running=true），刷新页面 / 切换页面不会中断注入；
    - 前端轮询 GET /{novel_id}/blueprints/activation 恢复并跟踪「激活中…」，
      只有成功（done）或失败（error）才退出激活中；
    - 已抽取过的版本（has_settings / has_style 命中，如切回/再次激活）直接复用对应版本的
      设定与文风，不重复调 AI；抽取失败不阻断激活（蓝图仍生效），warning 供前端提示。
    """
    from app.services.pipeline import sync_active_blueprint_style

    bp = _get_blueprint(novel_id, blueprint_id, db)
    if bp.status == "active":
        db.refresh(bp)
        return {"running": False, "task_id": None, "blueprint_id": str(blueprint_id), "version": bp.version}

    # 已有进行中的激活任务：拒绝重复启动（前端已禁用按钮，这里兜底防绕过）
    existing = db.execute(
        select(AgentTask).where(
            AgentTask.novel_id == novel_id,
            AgentTask.agent == AGENT_ACTIVATION,
            AgentTask.status == "running",
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "该小说已有蓝图正在激活中，请等待完成后再试。")

    # 先落一条「激活中」标记：页面刷新/切页后前端据此恢复按钮的「激活中…」状态
    task = AgentTask(
        novel_id=novel_id,
        agent=AGENT_ACTIVATION,
        params={"blueprint_id": str(blueprint_id), "version": bp.version, "doc_name": bp.doc_name},
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    async def background_activate() -> None:
        # 独立会话：任务脱离请求生命周期（get_db 的会话随请求结束关闭，不能用）
        task_db = SessionLocal()
        try:
            b = task_db.get(Blueprint, blueprint_id)
            if b is None:
                _finish_activation(task_db, task.id, status="error", error="蓝图不存在，可能已被删除。")
                return
            # 生效前注入：先抽取设定/文风（全部完成后再一次性切换生效状态）。
            # 已注入过该版本直接复用原数据；「注入完成 = 生效完成」，保证激活结束即注入完毕。
            warning = await _run_blueprint_injection(task_db, novel_id, blueprint_id)
            # 注入完成，切换生效状态（全书唯一 active）：旧 active → inactive，本蓝图 → active
            task_db.execute(
                Blueprint.__table__.update()
                .where(Blueprint.novel_id == novel_id, Blueprint.status == "active")
                .values(status="inactive")
            )
            b.status = "active"
            task_db.commit()
            # 全局文风跟随生效蓝图：有该蓝图提炼的文风就用它，否则清空（手动文风不受影响）
            sync_active_blueprint_style(task_db, novel_id, blueprint_id)
            # 收尾：标记完成（前端轮询到「不再 running」即退出激活中）；warning 写入 params 供前端提示
            t = task_db.get(AgentTask, task.id)
            if t is not None:
                t.status = "done"
                t.msg = (
                    f"蓝图 v{b.version} 已设为生效中；蓝图导入的设定与文风已跟随切换"
                    "（原生效蓝图的内容已隐藏，可随时切回该版本恢复）。"
                )
                if warning:
                    t.params = {**(t.params or {}), "warning": warning}
                task_db.commit()
        except Exception as e:
            logger.exception("blueprint=%s 后台激活失败", blueprint_id)
            _finish_activation(task_db, task.id, status="error", error=str(e))
        finally:
            task_db.close()

    asyncio.create_task(background_activate())
    return {
        "running": True,
        "task_id": str(task.id),
        "blueprint_id": str(blueprint_id),
        "version": bp.version,
    }


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
