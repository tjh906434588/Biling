"""概念卡片 API：列表 / 确认转正（→settings）/ 拒绝。

转正规则（§5.1 概念师→设定库）：
- 允许 type ∈ {character, location, faction, world_rule, item, concept} → 建 Setting。
- world_rule 转正为宪法（is_constitution=True）。
- 同名同类型设定已存在（未删未合并）→ 跳过创建，避免"同一角色两条设定"。
- plot_idea/other 不建设定，卡片直接 integrated（仅沉淀为概念）。
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ConceptCard, Novel, Setting
from app.db.session import get_db
from app.schemas.concept import ConceptCardRead, ConceptConfirmResult

router = APIRouter(prefix="/api/novels", tags=["concepts"])

_SETTING_TYPES = {"character", "location", "faction", "world_rule", "item", "concept"}


def _get_card(novel_id: uuid.UUID, card_id: uuid.UUID, db: Session) -> ConceptCard:
    card = db.get(ConceptCard, card_id)
    if card is None or card.novel_id != novel_id:
        raise HTTPException(404, "概念卡片不存在")
    return card


@router.get("/{novel_id}/concepts", response_model=list[ConceptCardRead])
def list_concepts(
    novel_id: uuid.UUID,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    stmt = select(ConceptCard).where(ConceptCard.novel_id == novel_id)
    if status:
        stmt = stmt.where(ConceptCard.status == status)
    return db.execute(stmt.order_by(ConceptCard.created_at.desc())).scalars().all()


@router.post("/{novel_id}/concepts/{card_id}/confirm", response_model=ConceptConfirmResult)
def confirm_concept(novel_id: uuid.UUID, card_id: uuid.UUID, db: Session = Depends(get_db)):
    """确认概念：转正为 settings 条目（幂等，同名跳过）。"""
    card = _get_card(novel_id, card_id, db)
    if card.status == "rejected":
        raise HTTPException(400, "已拒绝的卡片不可确认")
    if card.status == "integrated":
        return ConceptConfirmResult(card_id=card.id, status=card.status, settings_created=[], skipped=[])

    extracted = card.extracted or {}
    item_type = extracted.get("type", "concept")
    name = str(extracted.get("name", "")).strip()
    if not name:
        raise HTTPException(422, "卡片缺少实体名，无法转正")

    created: list[dict] = []
    skipped: list[str] = []
    if item_type in _SETTING_TYPES:
        existing = db.execute(
            select(Setting).where(
                Setting.novel_id == novel_id,
                Setting.type == item_type,
                Setting.name == name,
                Setting.deleted_at.is_(None),
                Setting.merged_into_id.is_(None),
            )
        ).scalar_one_or_none()
        if existing is not None:
            skipped.append(f"{item_type}:{name}（已存在）")
        else:
            structured = extracted.get("extracted") or {}
            if not isinstance(structured, dict):
                structured = {"note": structured}
            aliases = extracted.get("aliases") or structured.get("aliases") or []
            if not isinstance(aliases, list):
                aliases = []
            # 设定库 UI 依赖 structured.constitution_text / dynamic_text 展示内容；
            # AI 抽取的 description（或用户原话）放进「不可变」栏，其余抽取细节原样保留。
            description = structured.pop("description", None) or card.raw_text
            structured.setdefault("constitution_text", description)
            structured.setdefault("dynamic_text", "")
            row = Setting(
                novel_id=novel_id,
                type=item_type,
                name=name,
                description=description,
                structured=structured,
                is_constitution=(item_type == "world_rule"),
                aliases=aliases,
                source="manual",
            )
            db.add(row)
            db.flush()
            created.append({"type": item_type, "name": name, "id": str(row.id)})

    card.status = "integrated"
    db.commit()
    return ConceptConfirmResult(
        card_id=card.id,
        status=card.status,
        settings_created=created,
        skipped=skipped,
    )


@router.post("/{novel_id}/concepts/{card_id}/reject", response_model=ConceptCardRead)
def reject_concept(novel_id: uuid.UUID, card_id: uuid.UUID, db: Session = Depends(get_db)):
    card = _get_card(novel_id, card_id, db)
    if card.status == "integrated":
        raise HTTPException(400, "已转正的卡片不可拒绝")
    card.status = "rejected"
    db.commit()
    db.refresh(card)
    return card
