"""FastAPI 入口：CORS、路由挂载、启动建表（开发便利；生产走 Alembic 迁移）。"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# 让 app 各模块的 INFO 日志可见（uvicorn 默认不配置应用 logger，会吞掉）
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

from app.api import (
    blueprints,
    chapters,
    concepts,
    detect,
    graph,
    ledger,
    memory,
    models,
    novels,
    outlines,
    prompts,
    stream,
    style,
)
from app.config import get_settings
from app.db.base import Base
from app.db.migrate import ensure_columns, ensure_prompts_schema
from app.db.session import engine

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # M0 开发便利：启动时建表；正式迁移走 alembic upgrade head
    Base.metadata.create_all(bind=engine)
    # M2 尾巴：为既有 SQLite 表幂等补列（aliases/merged_into_id、since_chapter 等）
    ensure_columns(engine)
    # M4 尾巴：prompts 表 key 单列唯一 -> key+scope 联合唯一（写作指令按小说独立）
    ensure_prompts_schema(engine)
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

app.include_router(novels.router)
app.include_router(chapters.router)
app.include_router(outlines.router)
app.include_router(ledger.router)
app.include_router(blueprints.router)
app.include_router(concepts.router)
app.include_router(style.router)
app.include_router(detect.router)
app.include_router(graph.router)
app.include_router(memory.router)
app.include_router(stream.router)
app.include_router(models.router)
app.include_router(prompts.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": settings.app_name}


@app.get("/")
def root():
    return {"app": settings.app_name, "docs": "/docs"}
