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
from app.db.models import AgentTask
from app.db.session import SessionLocal, get_db
from app.schemas.agents import AgentCommitRequest, AgentRunRequest
from app.services.pipeline import commit_agent_output, run_agent_stream

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stream/agents", tags=["stream"])

# 进行中任务的流式文字进度缓存（内存态，key=task_id）。
# 用途：页面刷新 / 切页后 SSE 连接已断开，前端轮询 tasks 接口时据此恢复已生成的文字，
# 避免刷新后生成过程弹窗只剩占位文字（刷新前已流出的内容也能看到，并随轮询继续滚动）。
PROGRESS: dict[str, dict[str, str]] = {}


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
    """
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

    async def background_run() -> None:
        # 独立会话：任务脱离请求生命周期（get_db 的会话随请求结束关闭，不能用）
        task_db = SessionLocal()
        try:
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
            _finish_task(task_db, task.id, status="done", msg="生成完成")
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
