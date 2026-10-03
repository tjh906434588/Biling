"""AI 角色元数据 API：角色中文名（唯一权威源 app/agents/roles.py）透传给前端。

前端任务通知/确认弹窗/调试页不再各自维护一份中文名，统一从这里拉取，
保证同一角色全项目叫法一致（改名字只改 roles.py 一处）。
"""
from fastapi import APIRouter

from app.agents.roles import ROLE_NAMES

router = APIRouter(prefix="/api/agents", tags=["agents"])


@router.get("/meta")
def agent_meta() -> dict[str, str]:
    """返回 {角色 key: 中文名} 全量映射，前端拉取后缓存使用。"""
    return ROLE_NAMES
