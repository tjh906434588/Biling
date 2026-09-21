"""章节大纲 API：列表（每章一条当前生效版）/ 批准激活 / 版本历史。"""
import asyncio
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.db.models import AgentTask, Chapter, Novel, Outline, Setting
from app.db.session import SessionLocal, get_db
from app.schemas.ledger import OutlineRead

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/novels", tags=["outlines"])

# 批准任务的 agent 标记：仅用于 agent_tasks 持久化「批准中」状态（不注册进 agents.REGISTRY）
AGENT_APPROVAL = "outline_approval"


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


def _inject_outline_characters(db: Session, novel_id: uuid.UUID, outline: Outline) -> list[str]:
    """大纲批准时：把该版大纲登场且设定库没有的角色注入设定库（source="outline" + outline_ids）。

    - 判定「新角色」：按 name 及 aliases 匹配该小说现有 character 设定（含被过滤隐藏的）。
    - 已存在角色：
      * 由 outline 注入 → 把当前版本 id 追加进 outline_ids（去重，跨章多来源共同持有）
      * 手动/蓝图设定卡 → 不动（始终可见）
    - 新建卡：type=character，structured 带 role_rank/appear_from=本章号/position，
      source="outline"，outline_ids=[本版本]（隐形字段，不展示；任一来源版本仍批准即可见）。

    幂等：重复批准同一版本不会重复建卡/重复追加。返回本次新建的角色名。
    """
    content = outline.content or {}
    chars = content.get("characters") or []
    existing = db.execute(
        select(Setting).where(
            Setting.novel_id == novel_id,
            Setting.type == "character",
            Setting.deleted_at.is_(None),
        )
    ).scalars().all()
    by_name: dict[str, Setting] = {}
    for s in existing:
        by_name[s.name] = s
        for al in s.aliases or []:
            by_name[al] = s

    injected: list[str] = []
    changed = False
    for c in chars:
        name = c if isinstance(c, str) else (c.get("name") if isinstance(c, dict) else None)
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()
        position = c.get("position") if isinstance(c, dict) else None
        note = c.get("note") if isinstance(c, dict) else None
        card = by_name.get(name)
        if card is not None:
            # 已存在：由大纲注入 → 追加本版本为来源（多值共同持有，任一来源仍批准即可见）
            if card.source == "outline":
                ids = list(card.outline_ids or [])
                sid = str(outline.id)
                if sid not in ids:
                    card.outline_ids = ids + [sid]
                    changed = True
            continue
        db.add(Setting(
            novel_id=novel_id,
            type="character",
            name=name,
            source="outline",
            outline_ids=[str(outline.id)],  # JSON 列存字符串（UUID 不可直接序列化）
            description=(note or "").strip() or f"第{outline.chapter_no}章登场",
            structured={
                "role_rank": "minor",
                "position": (position or "").strip() or None,
                "appear_from": outline.chapter_no,  # 从本章起才注入上下文，避免时间悖论
            },
            is_constitution=False,
        ))
        injected.append(name)
        changed = True
    if changed:
        db.commit()
    return injected


def _iso_utc(dt) -> str | None:
    """数据库 DateTime 由 SQLite CURRENT_TIMESTAMP 写入，为 UTC 且无时区标记；序列化时补 Z。"""
    return dt.isoformat() + "Z" if dt else None


def _finish_approval(
    db: Session,
    task_id: uuid.UUID,
    *,
    status: str,
    msg: str | None = None,
    error: str | None = None,
    injected: list[str] | None = None,
) -> None:
    """后台批准结束时更新 agent_tasks 记录状态（供前端刷新/切页后轮询收尾）。"""
    t = db.get(AgentTask, task_id)
    if t is None:
        return
    t.status = status
    if msg is not None:
        t.msg = msg
    if error is not None:
        t.error = error
    if injected is not None:
        t.params = {**(t.params or {}), "injected_characters": injected}
    db.commit()


@router.get("/{novel_id}/outlines/approval")
def outline_approval_status(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """查询该小说最近一次「大纲批准」任务：页面刷新/切页后前端据此恢复「批准中…」按钮状态。

    - running=true：后台仍在注入（角色设定 + 账本同步），按钮保持「批准中…」（成功/失败才退出）；
    - task：最近一次批准任务（含 outline_id / chapter_no / version_no / injected_characters），
      供完成时展示「登记了几个新角色」。
    """
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    task = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id, AgentTask.agent == AGENT_APPROVAL)
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
            "outline_id": params.get("outline_id"),
            "chapter_no": params.get("chapter_no"),
            "version_no": params.get("version_no"),
            "status": task.status,
            "msg": task.msg,
            "error": task.error,
            "injected_characters": params.get("injected_characters") or [],
            "started_at": _iso_utc(task.created_at),
            "updated_at": _iso_utc(task.updated_at),
        },
    }


@router.post("/{novel_id}/outlines/{outline_id}/approve")
async def approve_outline(novel_id: uuid.UUID, outline_id: uuid.UUID, db: Session = Depends(get_db)):
    """大纲批准激活：指定版本 approved，同章其他版本全部降回 draft。

    版本语义：同章最多一个 approved（下游唯一依据），批准即「切换到此版本」。

    批准从请求生命周期解耦为后台任务（agent_tasks，agent=outline_approval）：
    - 请求立即返回（running=true），按钮进入「批准中…」，刷新/切页不中断；
    - 后台按顺序执行：① 注入本版登场的新角色（带来源版本）→ ② 同步账本（覆盖重算本章）→
      ③ 全部完成后再把本版置 approved（同章其他版本降回 draft）——保证「注入全部走完才算版本生成」，
      期间任一环节失败则任务 error、版本保持未批准；
    - 前端轮询 GET /{novel_id}/outlines/approval，只有成功（done）或失败（error）才退出「批准中…」。
    """
    outline = db.get(Outline, outline_id)
    if outline is None or outline.novel_id != novel_id:
        raise HTTPException(404, "大纲不存在")

    # 已有进行中的批准任务：拒绝重复启动（前端已禁用按钮，这里兜底防绕过）
    existing = db.execute(
        select(AgentTask).where(
            AgentTask.novel_id == novel_id,
            AgentTask.agent == AGENT_APPROVAL,
            AgentTask.status == "running",
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "该小说已有大纲正在批准注入中，请等待完成后再试。")

    # 先落一条「批准中」标记：页面刷新/切页后前端据此恢复按钮的「批准中…」状态
    task = AgentTask(
        novel_id=novel_id,
        agent=AGENT_APPROVAL,
        params={
            "outline_id": str(outline_id),
            "chapter_no": outline.chapter_no,
            "version_no": outline.version_no,
        },
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    async def background_approve() -> None:
        # 独立会话：任务脱离请求生命周期（get_db 的会话随请求结束关闭，不能用）
        task_db = SessionLocal()
        try:
            from app.services.pipeline import sync_ledger_from_outline

            o = task_db.get(Outline, outline_id)
            if o is None or o.novel_id != novel_id:
                _finish_approval(task_db, task.id, status="error", error="大纲不存在，可能已被删除。")
                return
            # ① 注入本版登场的新角色（幂等；已生效版本里被隐藏的同名角色追加为本版来源）
            injected = _inject_outline_characters(task_db, novel_id, o)
            # ② 登记账本：与设定一致，只有批准版大纲的伏笔动作进入账本（覆盖重算，切回旧版本自然恢复）
            sync_ledger_from_outline(task_db, novel_id, o.chapter_no, outline_id=o.id)
            # ③ 注入全部完成 → 本版置 approved（同章其他版本降回 draft），版本才算生成
            task_db.query(Outline).filter(
                Outline.novel_id == novel_id,
                Outline.chapter_no == o.chapter_no,
                Outline.id != outline_id,
                Outline.status == "approved",
            ).update({"status": "draft"})
            o.status = "approved"
            task_db.commit()
            _finish_approval(
                task_db,
                task.id,
                status="done",
                msg=f"第 {o.chapter_no} 章大纲 v{o.version_no} 已批准此版本，设定与账本已注入。",
                injected=injected,
            )
        except Exception as e:
            logger.exception("outline=%s 后台批准失败", outline_id)
            _finish_approval(task_db, task.id, status="error", error=str(e))
        finally:
            task_db.close()

    asyncio.create_task(background_approve())
    return {
        "running": True,
        "task_id": str(task.id),
        "outline_id": str(outline_id),
        "chapter_no": outline.chapter_no,
        "version_no": outline.version_no,
    }
