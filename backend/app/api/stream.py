"""SSE 流式路由：/api/stream/agents/{agent}/run（技术设计 §10/§11）。

生成任务已从请求生命周期解耦为后台任务（agent_tasks 表）：页面刷新 / 连接断开后
任务继续生成并落库，前端可通过 GET /{agent}/tasks 查询进行中任务并恢复状态。
"""
import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents.registry import AGENT_NAMES
from app.db.models import AgentTask, Chapter, ChapterVersion, Outline, QualityReview
from app.db.session import SessionLocal, get_db
from app.schemas.agents import AgentCommitRequest, AgentRunRequest
from app.services.pipeline import commit_agent_output, run_agent_stream

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stream/agents", tags=["stream"])

# 进行中任务的流式文字进度缓存（内存态，key=task_id）。
# 用途：页面刷新 / 切页后 SSE 连接已断开，前端轮询 tasks 接口时据此恢复已生成的文字，
# 避免刷新后生成过程弹窗只剩占位文字（刷新前已流出的内容也能看到，并随轮询继续滚动）。
PROGRESS: dict[str, dict[str, str]] = {}

# 后台任务绝对超时（秒）：LLM 请求已单独限时（LLM_REQUEST_TIMEOUT_SECONDS=600），
# 这里留足重试/校验/落库缓冲。防止任务永久 running（曾因 LLM 挂起卡死 20+ 分钟）。
TASK_ABSOLUTE_TIMEOUT_SECONDS = 1200


# ---------- 生成后自动评价（签约适配检查） ----------
# novelist/reviser 生成正文落库成功后，自动排队评价师对**本次生成的新版本**做签约适配检查，
# 无需作者手动点「评价」。评价落库时按 severity=high 的红线 issue 标记该版本 signing_blocked，
# 定稿（select_version）时默认拒绝——形成「高风险问题未解决时禁止定稿」的硬性门槛。

# 与前端 writing-panel 的 summarizeOutline 同构：把已批大纲压成评价对照摘要
def _summarize_outline(o: Outline) -> str:
    c = o.content or {}
    parts: list[str] = []
    if c.get("goal"):
        parts.append(f"目标：{c['goal']}")
    beats = [b.get("content") for b in (c.get("beats") or []) if b.get("content")]
    if beats:
        parts.append(f"节拍：{'；'.join(beats)[:400]}")
    pf = [p.get("desc") for p in (c.get("plant_foreshadowing") or []) if p.get("desc")]
    if pf:
        parts.append("埋设：" + "、".join(pf))
    rf = [r.get("how") for r in (c.get("resolve_foreshadowing") or []) if r.get("how")]
    if rf:
        parts.append("回收：" + "、".join(rf))
    return "\n".join(parts)


def _find_new_versions(db: Session, novel_id: uuid.UUID, chapter_no: int, since) -> list[ChapterVersion]:
    """本次生成任务新落库的版本：该章 created_at >= 任务开始时间 的版本行。"""
    chapter = db.execute(
        select(Chapter).where(Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no)
    ).scalar_one_or_none()
    if chapter is None:
        return []
    return list(
        db.execute(
            select(ChapterVersion)
            .where(ChapterVersion.chapter_id == chapter.id, ChapterVersion.created_at >= since)
            .order_by(ChapterVersion.created_at)
        ).scalars()
    )


def _build_auto_review_params(
    db: Session, novel_id: uuid.UUID, version: ChapterVersion, chapter_no: int
) -> dict:
    """构造自动评价的 critic 参数：与前端 handleReview 同口径（含大纲摘要）。"""
    outline_text = ""
    approved = db.execute(
        select(Outline).where(
            Outline.novel_id == novel_id,
            Outline.chapter_no == chapter_no,
            Outline.status == "approved",
        )
    ).scalar_one_or_none()
    if approved is not None:
        outline_text = _summarize_outline(approved)
    return {
        "chapter_no": chapter_no,
        "chapter_text": version.content,
        "chapter_version_id": str(version.id),
        "writing_mode": "draft_free",
        "outline": outline_text or None,
    }


async def _run_auto_review(novel_id: uuid.UUID, params: dict, task_id: uuid.UUID) -> None:
    """自动评价后台任务：跑完 critic 并落库，最后标记任务 done/error。

    独立的 session（脱离发起任务生命周期）；SSE 事件无人消费，直接丢弃（不转发），
    生成与落库照常进行。整体超时兜底与发起任务同口径。
    """
    task_db = SessionLocal()
    try:
        async with asyncio.timeout(TASK_ABSOLUTE_TIMEOUT_SECONDS):
            async for _sse in run_agent_stream(task_db, "critic", novel_id, params):
                pass  # 自动评价无前端 SSE 消费者：事件只用来驱动生成，落库由 pipeline 完成
    except Exception as e:
        logger.exception("agent=critic task=%s 自动评价失败", task_id)
        _finish_task(task_db, task_id, status="error", error=str(e))
    else:
        _finish_task(task_db, task_id, status="done", msg="自动评价完成")
    finally:
        task_db.close()


def _schedule_auto_reviews(db: Session, novel_id: uuid.UUID, agent_name: str, params: dict, task_created_at) -> None:
    """novelist/reviser 落库成功后调用：为本次新生成的版本自动排队评价师。

    守卫：
    - 只对 novelist/reviser（有正文产出的生成类角色）触发；
    - 每个新版本若已有评价则跳过（幂等，不重复评价）；
    - 该小说已有 critic 任务在跑（含用户手动评价）则整批跳过，避免并发评价/限流。
    """
    if agent_name not in ("novelist", "reviser"):
        return
    chapter_no = params.get("chapter_no")
    if chapter_no is None:
        return
    running_critic = db.execute(
        select(AgentTask).where(
            AgentTask.novel_id == novel_id,
            AgentTask.agent == "critic",
            AgentTask.status == "running",
        )
    ).scalar_one_or_none()
    if running_critic is not None:
        logger.info("novel_id=%s 已有 critic 任务运行中，跳过本次自动评价", novel_id)
        return

    versions = _find_new_versions(db, novel_id, chapter_no, task_created_at)
    for ver in versions:
        has_review = db.execute(
            select(QualityReview.id).where(QualityReview.chapter_version_id == ver.id).limit(1)
        ).scalar_one_or_none()
        if has_review is not None:
            continue
        review_params = _build_auto_review_params(db, novel_id, ver, chapter_no)
        critic_task = AgentTask(novel_id=novel_id, agent="critic", params=review_params)
        db.add(critic_task)
        db.commit()
        db.refresh(critic_task)
        asyncio.create_task(_run_auto_review(novel_id, review_params, critic_task.id))
        logger.info(
            "novel_id=%s 第%s章 生成完成，已自动排队评价师（版本=%s）",
            novel_id, chapter_no, ver.id,
        )


async def _run_memory_keeper(novel_id: uuid.UUID, params: dict, task_id: uuid.UUID) -> None:
    """编年生成后台任务：跑完 memory_keeper 并落库，最后标记任务 done/error。"""
    task_db = SessionLocal()
    try:
        async with asyncio.timeout(TASK_ABSOLUTE_TIMEOUT_SECONDS):
            async for _sse in run_agent_stream(task_db, "memory_keeper", novel_id, params):
                pass  # 无前端 SSE 消费者：事件只用来驱动生成，落库由 pipeline 完成
    except Exception as e:
        logger.exception("agent=memory_keeper task=%s 编年生成失败", task_id)
        _finish_task(task_db, task_id, status="error", error=str(e))
    else:
        _finish_task(task_db, task_id, status="done", msg=f"编年已更新到第{params.get('up_to_chapter')}章")
    finally:
        task_db.close()


def _schedule_memory_keeper(db: Session, novel_id: uuid.UUID, agent_name: str, params: dict) -> None:
    """novelist/reviser 落库成功后调用：每 N 章自动触发一次编年师（长期记忆刷新）。

    守卫：
    - 只对正文生成类角色触发（novelist/reviser），且当前章节数正好是 chronicle_generate_every 的倍数；
    - 该小说已有 memory_keeper 任务在跑则跳过（避免并发写同一份编年）。
    """
    if agent_name not in ("novelist", "reviser"):
        return
    from app.config import get_settings

    every = get_settings().chronicle_generate_every
    if not every or every <= 0:
        return
    chapter_no = params.get("chapter_no")
    if chapter_no is None or chapter_no % every != 0:
        return
    running = db.execute(
        select(AgentTask).where(
            AgentTask.novel_id == novel_id,
            AgentTask.agent == "memory_keeper",
            AgentTask.status == "running",
        )
    ).scalar_one_or_none()
    if running is not None:
        logger.info("novel_id=%s 已有编年任务运行中，跳过本次触发", novel_id)
        return
    mem_params = {"up_to_chapter": chapter_no}
    mem_task = AgentTask(novel_id=novel_id, agent="memory_keeper", params=mem_params)
    db.add(mem_task)
    db.commit()
    db.refresh(mem_task)
    asyncio.create_task(_run_memory_keeper(novel_id, mem_params, mem_task.id))
    logger.info("novel_id=%s 第%s章 生成完成，已自动排队编年师", novel_id, chapter_no)


def _iso_utc(dt) -> str | None:
    """数据库 DateTime 由 SQLite CURRENT_TIMESTAMP 写入，为 UTC 且无时区标记；
    序列化时补 Z，前端 new Date() 才能按正确时区解析（否则会按本地时区解析，偏差 8 小时）。"""
    return dt.isoformat() + "Z" if dt else None


def _update_progress(task_id: uuid.UUID, sse_text: str) -> None:
    """从 SSE 事件文本中提取 thinking_delta / stream_delta，累积到 PROGRESS 缓存。"""
    name = ""
    data = ""
    for ln in sse_text.splitlines():
        if ln.startswith("event:"):
            name = ln[6:].strip()
        elif ln.startswith("data:"):
            data = ln[5:].strip()
    if name not in ("thinking_delta", "stream_delta") or not data:
        return
    try:
        import json

        delta = (json.loads(data).get("delta") or "") if data else ""
    except Exception:
        return
    if not delta:
        return
    key = "thinking" if name == "thinking_delta" else "draft"
    cur = PROGRESS.get(str(task_id), {"thinking": "", "draft": ""})
    cur[key] = cur.get(key, "") + delta
    PROGRESS[str(task_id)] = cur


def _finish_task(task_db: Session, task_id: uuid.UUID, *, status: str, msg: str | None = None, error: str | None = None) -> None:
    """后台任务结束时更新 agent_tasks 记录状态（供前端刷新后轮询）。

    done 时若任务已有 msg（如蓝图落库时写入的"蓝图 vX 已生成完毕…"），保留不覆盖；
    error 时始终写入错误信息。

    先 rollback 清掉当前事务：落库失败（如 JSON 序列化 TypeError）会让 session 进入
    PendingRollback 状态，此时不先回滚，下面的 get/commit 会再次抛 PendingRollbackError，
    导致任务状态永远停在 running（曾见 extractor 落库失败后任务一直 running、
    前端无完成提示、按钮高亮不灭、重试被 409 拒绝）。
    """
    try:
        task_db.rollback()
    except Exception:
        pass
    t = task_db.get(AgentTask, task_id)
    if t is None:
        return
    t.status = status
    if msg is not None and (status != "done" or not t.msg):
        t.msg = msg
    if error is not None:
        t.error = error
    task_db.commit()


@router.get("/status")
def stream_status(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """查询该小说最近一个 AI 生成任务（含进行中/刚完成），供前端刷新或切页回来后恢复状态。

    - running：后台仍在生成，前端提示"生成中"并轮询到完成（刷新/切页不会打断，结果照常落库）
    - recent：最近一次任务（done/error），用于提示"上次生成结果"
    """
    running = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id, AgentTask.status == "running")
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    recent = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id)
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    def to_dict(t: AgentTask) -> dict:
        return {
            "id": str(t.id),
            "agent": t.agent,
            "status": t.status,
            "msg": t.msg,
            "error": t.error,
            "chapter_no": (t.params or {}).get("chapter_no"),
            "started_at": _iso_utc(t.created_at),
            "updated_at": _iso_utc(t.updated_at),
        }

    return {
        "running": to_dict(running) if running else None,
        "recent": to_dict(recent) if recent else None,
    }


@router.get("/{agent}/tasks")
def agent_running_tasks(agent: str, novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """查询该小说该角色是否有进行中的生成任务。

    页面刷新后前端据此恢复"生成中"状态；progress 为刷新前已流出的文字
    （thinking/draft 累积），前端用于恢复流式显示并随轮询增量更新。
    """
    if agent not in AGENT_NAMES:
        raise HTTPException(404, f"未知角色：{agent}（可选：{', '.join(AGENT_NAMES)}）")
    task = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id, AgentTask.agent == agent, AgentTask.status == "running")
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    return {
        "running": task is not None,
        "task": {
            "id": str(task.id),
            "agent": task.agent,
            "status": task.status,
            "msg": task.msg,
            "error": task.error,
            "started_at": _iso_utc(task.created_at),
            "progress": PROGRESS.get(str(task.id), {"thinking": "", "draft": ""}),
        }
        if task
        else None,
    }


@router.post("/{agent}/run")
async def stream_agent_run(agent: str, payload: AgentRunRequest, db: Session = Depends(get_db)):
    """通用流式生成入口：context_ready → stream_delta* → stream_end → schema_validate → stored。

    dry_run=true（调试沙箱）时最后 stored 事件返回产出而不落库，用户可另调 commit 加入正式库。

    任务持久化：先落 agent_tasks（running），再启动后台任务跑生成；SSE 只转发事件。
    请求断开（刷新页面）不影响后台任务，完成后自动落库并更新任务状态。
    """
    if agent not in AGENT_NAMES:
        raise HTTPException(404, f"未知角色：{agent}（可选：{', '.join(AGENT_NAMES)}）")

    # 蓝图师前置校验：设定库为空时没有素材来源，直接拒绝（前端已禁用，这里兜底防绕过）。
    # 蓝图必须从设定出发，即使填了生成要求也不允许在零设定的情况下凭空生成。
    # 例外：导入模式（params.import_source）的素材来自用户上传的大纲文档，不受此限。
    if agent == "blueprint_architect" and not (payload.params or {}).get("import_source"):
        from app.agents.context import get_settings_snapshot

        if len(get_settings_snapshot(db, payload.novel_id)) == 0:
            raise HTTPException(
                400,
                "设定库为空，无法生成蓝图。请先在「设定」中添加角色、地点、规则等设定。",
            )

    # 同 novel + agent 已有进行中任务：拒绝重复启动（如刷新后误点），等它跑完
    existing = db.execute(
        select(AgentTask).where(
            AgentTask.novel_id == payload.novel_id,
            AgentTask.agent == agent,
            AgentTask.status == "running",
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "该角色已有生成任务在后台运行，请等待完成后再试。")

    task = AgentTask(novel_id=payload.novel_id, agent=agent, params=payload.params or {})
    db.add(task)
    db.commit()
    db.refresh(task)

    # 后台任务与 SSE 连接之间的转发队列。连接断开后无人消费，事件被丢弃（不阻塞后台任务）。
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    _SENTINEL = object()

    async def _run_background(task_db: Session, task: AgentTask) -> None:
        """后台生成主体：流式跑完并落库，最后把 agent_tasks 标记 done。

        novelist/reviser 生成成功（非 dry_run）后自动排队评价师：对本轮新落库的版本
         做签约适配检查（见 _schedule_auto_reviews）。评价在独立后台任务中异步进行，
         不阻塞本任务收尾。
        """
        async for sse in run_agent_stream(
            task_db,
            agent,
            payload.novel_id,
            payload.params,
            temperature=payload.temperature,
            max_tokens=payload.max_tokens,
            dry_run=payload.dry_run,
        ):
            _update_progress(task.id, sse)  # 累积流式文字，供刷新后恢复显示
            try:
                queue.put_nowait(sse)
            except asyncio.QueueFull:
                pass  # 连接已断/消费慢：丢弃事件，生成照常跑完并落库
        if not payload.dry_run:
            try:
                _schedule_auto_reviews(task_db, payload.novel_id, agent, payload.params, task.created_at)
            except Exception:
                # 自动评价排队失败不影响正文落库结果，仅记日志（正文已生成，作者可手动评价）
                logger.exception("novel_id=%s 自动评价排队失败（不影响正文落库）", payload.novel_id)
            try:
                _schedule_memory_keeper(task_db, payload.novel_id, agent, payload.params)
            except Exception:
                # 编年触发失败不影响正文落库，仅记日志（下个触发章节会再次尝试）
                logger.exception("novel_id=%s 编年触发失败（不影响正文落库）", payload.novel_id)
        _finish_task(task_db, task.id, status="done", msg="生成完成")

    async def background_run() -> None:
        # 独立会话：任务脱离请求生命周期（get_db 的会话随请求结束关闭，不能用）
        task_db = SessionLocal()
        # 整体超时兜底：LLM 请求已单独限时（LLM_REQUEST_TIMEOUT_SECONDS），这里再留
        # 足够缓冲（含重试/校验/落库），防止极端情况（如 LLM 层异常未抛）下任务永久
        # running——那会让「提取/生成没落库、按钮一直高亮」且前端永远显示"进行中"。
        try:
            async with asyncio.timeout(TASK_ABSOLUTE_TIMEOUT_SECONDS):
                await _run_background(task_db, task)
        except TimeoutError:
            logger.error("agent=%s task=%s 后台任务超时终止（%ss 未完成）", agent, task.id, TASK_ABSOLUTE_TIMEOUT_SECONDS)
            _finish_task(task_db, task.id, status="error", error="生成超时，已自动终止，请重试。")
            try:
                queue.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                pass
        except Exception as e:
            logger.exception("agent=%s task=%s 后台生成失败", agent, task.id)
            _finish_task(task_db, task.id, status="error", error=str(e))
            try:
                queue.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                pass
        finally:
            PROGRESS.pop(str(task.id), None)
            task_db.close()
            try:
                queue.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                pass

    asyncio.create_task(background_run())

    async def sse():
        try:
            while True:
                item = await queue.get()
                if item is _SENTINEL:
                    break
                yield item
        except asyncio.CancelledError:
            # 客户端断开（如刷新页面）：只退出转发循环，后台任务继续
            raise

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 关掉反代缓冲，保证流式
        },
    )


@router.post("/{agent}/commit")
async def commit_agent_run(agent: str, payload: AgentCommitRequest, db: Session = Depends(get_db)):
    """把调试 dry_run 的产物显式加入正式库（不重新调用 AI，复用各角色 _persist）。"""
    if agent not in AGENT_NAMES:
        raise HTTPException(404, f"未知角色：{agent}（可选：{', '.join(AGENT_NAMES)}）")
    try:
        return commit_agent_output(db, agent, payload.novel_id, payload.params, payload.output, payload.source)
    except Exception as e:
        logger.exception("agent=%s commit 失败", agent)
        raise HTTPException(422, f"提交失败：{e}")
