"""每部小说独立的写作指令 API：各创作/评审角色的结构化 System Prompt 片段配置。"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.agents.prompt_config import (
    CONFIGURABLE_AGENTS,
    _scope_for,
    delete_agent_prompt,
    get_agent_prompt_dict,
    resolve_fields,
    save_agent_prompt,
)
from app.db.models import PromptTemplate
from app.db.session import get_db
from app.schemas.prompts import AgentPromptRead, PromptUpdateIn

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


def _read_agent(key: str, novel_id: UUID, db: Session) -> AgentPromptRead:
    row = (
        db.query(PromptTemplate)
        .filter(PromptTemplate.key == key, PromptTemplate.scope == _scope_for(novel_id))
        .first()
    )
    saved = get_agent_prompt_dict(db, novel_id, key)
    configured = saved is not None
    # 未配置 -> 返回内置默认值（有值）；已配置 -> 返回保存内容（含清空的空字段，不回退默认）
    fields = resolve_fields(saved, key)
    return AgentPromptRead(
        key=key,
        name=CONFIGURABLE_AGENTS[key],
        configured=configured,
        fields=fields,
        updated_at=row.updated_at if row else None,
    )


@router.get("", response_model=list[AgentPromptRead])
def list_prompts(novel_id: UUID, db: Session = Depends(get_db)):
    """返回该小说全部可配置角色的当前生效值（含是否已自定义）。"""
    return [_read_agent(key, novel_id, db) for key in CONFIGURABLE_AGENTS]


@router.put("/{agent_key}", response_model=AgentPromptRead)
def update_prompt(agent_key: str, novel_id: UUID, payload: PromptUpdateIn, db: Session = Depends(get_db)):
    """保存该小说某角色的写作指令（字段留空 = 该字段不传给 AI，不回退默认）。"""
    if agent_key not in CONFIGURABLE_AGENTS:
        raise HTTPException(404, "未知角色")
    save_agent_prompt(db, novel_id, agent_key, payload.model_dump())
    return _read_agent(agent_key, novel_id, db)


@router.delete("/{agent_key}", response_model=AgentPromptRead)
def reset_prompt(agent_key: str, novel_id: UUID, db: Session = Depends(get_db)):
    """删除该小说某角色的自定义配置（恢复内置默认）。"""
    if agent_key not in CONFIGURABLE_AGENTS:
        raise HTTPException(404, "未知角色")
    delete_agent_prompt(db, novel_id, agent_key)
    return _read_agent(agent_key, novel_id, db)
