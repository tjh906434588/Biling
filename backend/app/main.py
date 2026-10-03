"""FastAPI 入口：CORS、路由挂载、启动建表（开发便利；生产走 Alembic 迁移）。"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import (
    blueprints,
    chapters,
    concepts,
    diagnostics,
    graph,
    ledger,
    memory,
    meta,
    models,
    novels,
    outlines,
    prompts,
    stream,
)
from app.config import get_settings
from app.logging_config import setup_logging

settings = get_settings()

# 日志落盘：data/logs/biling.log（桌面版排查问题的基础，详见 logging_config）；
# 级别由 BILING_LOG_LEVEL 控制（默认 INFO），可调音量避免噪音
setup_logging(
    settings.resolved_data_dir,
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
)

# 让 app 各模块的 INFO 日志可见（uvicorn 默认不配置应用 logger，会吞掉）
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

from app.db.base import Base
from app.db.migrate import ensure_columns, ensure_novel_background_type_nullable, ensure_prompts_schema
from app.db.session import engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动/关闭钩子：启动建表迁移、litellm 预导入、清理僵尸生成任务。"""
    # 开发便利：启动时建表；正式迁移走 alembic upgrade head
    Base.metadata.create_all(bind=engine)
    # 兼容旧库：为既有 SQLite 表幂等补列（aliases/merged_into_id、since_chapter 等）
    ensure_columns(engine)
    # 兼容旧库：prompts 表 key 单列唯一 -> key+scope 联合唯一（写作指令按小说独立）
    ensure_prompts_schema(engine)
    # 兼容旧库：novels.background_type 改可空（旧库 NOT NULL 无法表示「未选择」）——重建该表
    ensure_novel_background_type_nullable(engine)
    # 启动时预导入 litellm：把其首次 import 的开销（本地模型成本表加载等）放到启动阶段，
    # 避免第一个流式请求被 import 阻塞。
    try:
        from litellm import acompletion  # noqa: F401

        logging.getLogger("app.main").info("litellm 预导入完成")
    except Exception:
        logging.getLogger("app.main").exception("litellm 预导入失败")
    # 启动时清理僵尸任务：上一进程遗留的 running 任务已随进程死亡（后台任务线程消失），
    # 不清掉会永远占用"进行中"位，阻塞前端状态恢复与后续发起（409 拒绝新任务）。
    try:
        from app.db.models import AgentTask
        from app.db.session import SessionLocal

        _s = SessionLocal()
        try:
            _n = _s.query(AgentTask).filter(AgentTask.status == "running").update(
                {
                    AgentTask.status: "error",
                    AgentTask.error: "服务重启，上次生成任务中断，请重新发起。",
                }
            )
            _s.commit()
            if _n:
                logging.getLogger("app.main").info("启动清理僵尸 running 任务 %d 个", _n)
        finally:
            _s.close()
    except Exception:
        logging.getLogger("app.main").exception("启动清理僵尸任务失败")
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_logger = logging.getLogger("app.main")


@app.exception_handler(RequestValidationError)
async def _validation_exc_handler(request, exc: RequestValidationError):
    """请求参数不合法：记录明细（含字段错误）到日志，返回友好 422。"""
    _logger.warning("[validation] %s %s -> %s", request.method, request.url.path, exc.errors()[:5])
    return JSONResponse(
        status_code=422,
        content={"detail": "请求参数不合法", "errors": exc.errors()[:5]},
    )


@app.exception_handler(Exception)
async def _unhandled_exc_handler(request, exc: Exception):
    """未捕获异常兜底：完整堆栈落日志（桌面版导出日志排查的关键），返回统一 500。"""
    _logger.exception("[unhandled] %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "服务器内部错误，详情见日志"})

app.include_router(novels.router)
app.include_router(chapters.router)
app.include_router(outlines.router)
app.include_router(ledger.router)
app.include_router(blueprints.router)
app.include_router(concepts.router)
app.include_router(graph.router)
app.include_router(memory.router)
app.include_router(stream.router)
app.include_router(models.router)
app.include_router(prompts.router)
app.include_router(meta.router)
app.include_router(diagnostics.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": settings.app_name}


@app.get("/")
def root():
    return {"app": settings.app_name, "docs": "/docs"}
