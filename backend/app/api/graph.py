"""实体图谱 API（M4 §4.1 entity_relations）：图谱视图 / 关系查询。

节点来源：settings 实体（character/location/faction/...）+ entity_relations 中出现的实体名。
边来源：entity_relations 表（dynamic=剧情层，提取师自动抽取）。
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agents.context import filter_graph_relations_for_version
from app.db.models import Blueprint, EntityRelation, Novel, Outline, Setting
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

    版本区分（与设定页/注入侧同口径）：
    - 节点：蓝图来源设定只显示当前生效蓝图版本；大纲注入设定只显示来源版本仍批准的；
      手动/批量设定始终显示（不可见版本不删，切回自动恢复）。
    - 边：dynamic 关系按「提取时正文版本 == 该章当前激活版本」过滤（与注入一致，fail-closed）；
      被取代的旧关系在取代者版本仍激活时保持失效，切回旧版本（取代者版本不激活）时恢复显示。
    """
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")

    # 版本可见性口径与 list_settings 一致：当前生效蓝图 + 各章当前批准版大纲
    active_bp_id = db.execute(
        select(Blueprint.id)
        .where(Blueprint.novel_id == novel_id, Blueprint.status == "active")
        .order_by(Blueprint.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    approved_outline_ids = {
        str(x)
        for x in db.execute(
            select(Outline.id).where(Outline.novel_id == novel_id, Outline.status == "approved")
        ).scalars()
    }

    nodes: dict[str, GraphNode] = {}
    for s in db.execute(
        select(Setting).where(
            Setting.novel_id == novel_id,
            Setting.deleted_at.is_(None),
            Setting.merged_into_id.is_(None),
        )
    ).scalars():
        # 版本过滤：不可见版本的设定不进入图谱节点（切回版本自动恢复显示）
        if s.source == "blueprint" and (s.blueprint_id is None or s.blueprint_id != active_bp_id):
            continue
        if s.source == "outline" and not (
            s.outline_ids and any(o in approved_outline_ids for o in s.outline_ids)
        ):
            continue
        kind = s.type if s.type in _KIND_GROUP else "other"
        nodes[s.name] = GraphNode(
            id=s.name,
            label=s.name,
            kind=kind,
            group=_KIND_GROUP.get(kind, 0),
            role_rank=(s.structured or {}).get("role_rank"),
        )

    rels = filter_graph_relations_for_version(
        db,
        novel_id,
        list(db.execute(select(EntityRelation).where(EntityRelation.novel_id == novel_id)).scalars()),
    )
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
