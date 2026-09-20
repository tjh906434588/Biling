"""实体图谱 API（M4 §4.1 entity_relations）：图谱视图 / 关系查询。

节点来源：settings 实体（character/location/faction/...）+ entity_relations 中出现的实体名。
边来源：entity_relations 表（dynamic=剧情层，提取师自动抽取）。
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import EntityRelation, Novel, Setting
from app.db.session import get_db
from app.schemas.graph import GraphEdge, GraphNode, GraphView, RelationRead

router = APIRouter(prefix="/api/novels", tags=["graph"])

_KIND_GROUP = {
    "character": 1,
    "location": 2,
    "faction": 3,
    "world_rule": 4,
    "item": 5,
    "concept": 6,
    "other": 0,
}


@router.get("/{novel_id}/graph", response_model=GraphView)
def get_graph(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """图谱视图：节点（settings + 关系两端）+ 边。

    边不过滤重复：过滤 archived（被取代的旧关系）后，每一行都是一条线，
    相同 (source, relation, target) 跨章重复时全部返回（前端合并标签展示章节列表）。
    """
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")

    nodes: dict[str, GraphNode] = {}
    for s in db.execute(
        select(Setting).where(
            Setting.novel_id == novel_id,
            Setting.deleted_at.is_(None),
            Setting.merged_into_id.is_(None),
        )
    ).scalars():
        kind = s.type if s.type in _KIND_GROUP else "other"
        nodes[s.name] = GraphNode(
            id=s.name,
            label=s.name,
            kind=kind,
            group=_KIND_GROUP.get(kind, 0),
            role_rank=(s.structured or {}).get("role_rank"),
        )

    rels = db.execute(
        select(EntityRelation)
        .where(EntityRelation.novel_id == novel_id, EntityRelation.archived.is_(False))
    ).scalars().all()
    # 不去重：每一行都是一条线（前端按三元组分组合并标签）
    edges: list[GraphEdge] = []
    for r in sorted(rels, key=lambda r: (r.chapter_no or 0, r.created_at)):
        for name, kind in ((r.source, "other"), (r.target, "other")):
            if name not in nodes:
                nodes[name] = GraphNode(id=name, label=name, kind=kind, group=0)
        edges.append(
            GraphEdge(id=r.id, source=r.source, target=r.target, label=r.relation, type=r.type, confidence=r.confidence, chapter_no=r.chapter_no)
        )

    return GraphView(nodes=list(nodes.values()), edges=edges)


@router.get("/{novel_id}/graph/relations", response_model=list[RelationRead])
def list_relations(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    return db.execute(
        select(EntityRelation).where(EntityRelation.novel_id == novel_id).order_by(EntityRelation.created_at)
    ).scalars().all()


@router.delete("/{novel_id}/graph/relations/{rel_id}", status_code=204)
def delete_relation(novel_id: uuid.UUID, rel_id: uuid.UUID, db: Session = Depends(get_db)):
    row = db.get(EntityRelation, rel_id)
    if row is None or row.novel_id != novel_id:
        raise HTTPException(404, "关系不存在")
    db.delete(row)
    db.commit()
