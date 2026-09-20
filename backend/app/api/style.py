"""风格画像 API：版本列表 / 从编辑 diff 学习新版本（§9）。"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents.style_learner import learn_style
from app.db.models import Novel, StyleProfile
from app.db.session import get_db
from app.schemas.style import StyleLearnIn, StyleLearnResult, StyleProfileRead

router = APIRouter(prefix="/api/novels", tags=["style"])


@router.get("/{novel_id}/style", response_model=list[StyleProfileRead])
def list_style_profiles(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    return db.execute(
        select(StyleProfile)
        .where(StyleProfile.novel_id == novel_id)
        .order_by(StyleProfile.version.desc())
    ).scalars().all()


@router.post("/{novel_id}/style/learn", response_model=StyleLearnResult)
async def learn_style_api(novel_id: uuid.UUID, payload: StyleLearnIn, db: Session = Depends(get_db)):
    """从用户编辑 diff 学习风格，生成 style_profiles 新版本（供小说家 L2 使用）。"""
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    try:
        return await learn_style(db, novel_id, payload.diffs)
    except RuntimeError as e:
        # 未接入模型等业务错误 → 4xx，前端直接展示给用户
        raise HTTPException(400, str(e))
