"""小说整本备份（导出 / 导入）。

用途：把某一本书的**全部业务数据**打包成 zip（换电脑 / 备份场景），导入时还原为
一本内容完全相同的新书（内部 id 全部重生成、表间引用跟随重映射），可无缝续写。

约定：
- 只导出"内容数据"表；不导出模型密钥（provider_keys）、全局配置（model_routes /
  app_preferences）、AI 生成任务历史（agent_tasks / author_confirms）。
- prompts 表按 scope 前缀 `novel:<id>` 导出该书专属的写作指令。
- 导出 zip 含 manifest.json（格式/版本信息）+ novel.json（整本书数据）。
- 导入总是新建一本（新 novel id），绝不覆盖现有书，天然无冲突。
"""
from __future__ import annotations

import importlib.metadata
import io
import json
import uuid
import zipfile
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy import Uuid, DateTime
from sqlalchemy.orm import Session

from app.db.base import Base
from app.db.models import Novel

# 导出表清单（novels 单独处理，不在其中）
EXPORT_TABLES: list[str] = [
    "blueprints",
    "outlines",
    "settings",
    "concept_cards",
    "plot_ledger",
    "chapters",
    "chapter_versions",
    "story_state",
    "entity_relations",
    "quality_reviews",
    "blueprint_styles",
    "novel_memories",
    "style_profiles",
    "prompts",
]

# 每张表除 novel_id 外需要跟随"旧 id → 新 id"重映射的 UUID 引用列
UUID_REF_FIELDS: dict[str, list[str]] = {
    "blueprints": ["parent_id"],  # 版本链自引用
    "outlines": ["blueprint_id"],
    "settings": ["blueprint_id", "merged_into_id"],
    "plot_ledger": ["outline_id"],
    "chapters": ["outline_id"],
    "chapter_versions": ["chapter_id", "outline_id", "parent_version_id"],
    "story_state": ["chapter_version_id"],
    "entity_relations": ["chapter_version_id", "superseded_by_version"],
    "quality_reviews": ["chapter_version_id"],
    "blueprint_styles": ["blueprint_id"],
}

# JSON 列内嵌的旧 id 列表（导入时同样重映射，如 settings.outline_ids）
JSON_UUID_FIELDS: dict[str, list[str]] = {
    "settings": ["outline_ids"],
}

_FORMAT = "biling-novel"
_SCHEMA_VERSION = 1


def _app_version() -> str:
    try:
        return importlib.metadata.version("biling-backend")
    except Exception:
        return "dev"


# ---------------------------------------------------------------- 导出

def _dump_row(row: dict[str, Any]) -> dict[str, Any]:
    """把一行数据序列化为可 JSON 化的 dict（UUID → str、datetime → iso）。"""
    out: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, uuid.UUID):
            out[k] = str(v)
        elif isinstance(v, datetime):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


def dump_novel_tables(db: Session, novel_id: uuid.UUID) -> dict[str, list[dict]]:
    """按 novel_id 收集这本书在全部业务表里的数据（novels 主行也在其中）。"""
    meta = Base.metadata
    tables: dict[str, list[dict]] = {}
    for tname in ["novels"] + EXPORT_TABLES:
        t = meta.tables[tname]
        if tname == "novels":
            # 主表自身没有 novel_id 列，按主键 id 取
            rows = db.execute(select(t).where(t.c.id == novel_id)).mappings().all()
        elif tname == "prompts":
            # 写作指令按 scope 前缀归属小说：scope = novel:<novel_id> 或 novel:<novel_id>:<key>
            rows = db.execute(select(t).where(t.c.scope.like(f"novel:{novel_id}%"))).mappings().all()
        elif tname == "chapter_versions":
            # 该表没有 novel_id 列，通过「本书的章节 id」关联过滤（chapters 已先导出，id 已是 str）
            chapter_ids = [uuid.UUID(r["id"]) for r in tables["chapters"]]
            if not chapter_ids:
                rows = []
            else:
                rows = db.execute(select(t).where(t.c.chapter_id.in_(chapter_ids))).mappings().all()
        else:
            rows = db.execute(select(t).where(t.c.novel_id == novel_id)).mappings().all()
        tables[tname] = [_dump_row(dict(r)) for r in rows]
    return tables


def build_zip(db: Session, novel_id: uuid.UUID, novel_title: str) -> bytes:
    """导出整本书数据 → zip bytes。"""
    tables = dump_novel_tables(db, novel_id)
    manifest = {
        "format": _FORMAT,
        "schema_version": _SCHEMA_VERSION,
        "app_version": _app_version(),
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "novel_title": novel_title,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        z.writestr("novel.json", json.dumps({"tables": tables}, ensure_ascii=False))
    return buf.getvalue()


# ---------------------------------------------------------------- 导入

def _coerce_value(col: Any, v: Any) -> Any:
    """按列类型把 JSON 值转回 Python 值（UUID / datetime）。"""
    if v is None:
        return None
    if isinstance(col.type, Uuid):
        return uuid.UUID(str(v))
    if isinstance(col.type, DateTime):
        return datetime.fromisoformat(str(v))
    return v


def _rebuild_row(
    table: Any,
    row: dict[str, Any],
    all_idmap: dict[str, uuid.UUID],
    new_novel_id: uuid.UUID,
    old_novel_id: str,
    tname: str,
) -> dict[str, Any]:
    """重建一行：主键换新、novel_id 换新、引用字段按全局映射重连、类型还原。"""
    out: dict[str, Any] = {}
    for col in table.columns:
        if col.name not in row:
            continue
        v = row[col.name]
        if v is None:
            out[col.name] = None
            continue
        if col.name == "id":
            v = all_idmap.get(str(v))
        elif col.name == "novel_id":
            v = new_novel_id
        elif col.name in UUID_REF_FIELDS.get(tname, []):
            v = all_idmap.get(str(v), str(v))
        # prompts.scope 里的小说 id 前缀跟随新书
        elif tname == "prompts" and col.name == "scope":
            v = str(v).replace(f"novel:{old_novel_id}", f"novel:{new_novel_id}")
        out[col.name] = _coerce_value(col, v)
    # JSON 列内嵌的旧 id 列表重映射
    for jf in JSON_UUID_FIELDS.get(tname, []):
        if out.get(jf):
            out[jf] = [str(all_idmap.get(str(x), str(x))) for x in out[jf]]
    return out


def restore_novel_from_zip(db: Session, payload: bytes) -> uuid.UUID:
    """从备份 zip 还原为一本内容完全相同的新书，返回新 novel id。

    抛 ValueError 表示文件格式/内容非法（调用方转 400）。
    """
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            manifest = json.loads(z.read("manifest.json"))
            data = json.loads(z.read("novel.json"))
    except Exception as e:
        raise ValueError(f"无法解析备份文件：{e}") from e

    if manifest.get("format") != _FORMAT:
        raise ValueError("不是 Biling 小说备份文件（格式不符）")
    if int(manifest.get("schema_version", 0)) > _SCHEMA_VERSION:
        raise ValueError("备份文件版本过新，请升级应用后再导入")

    tables: dict[str, list[dict]] = data.get("tables", {})
    novel_rows = tables.get("novels") or []
    if not novel_rows:
        raise ValueError("备份文件缺少小说数据")
    old_novel_id = str(novel_rows[0]["id"])

    # 1) 全局旧 id → 新 id 映射（UUID 全局唯一，跨表映射无碰撞）
    all_idmap: dict[str, uuid.UUID] = {}
    for tname in ["novels"] + EXPORT_TABLES:
        for r in tables.get(tname) or []:
            if r.get("id"):
                all_idmap[str(r["id"])] = uuid.uuid4()
    if old_novel_id not in all_idmap:
        raise ValueError("备份文件数据不完整（缺小说主记录）")
    new_novel_id = all_idmap[old_novel_id]

    # 2) 按依赖顺序重建（子表引用的父表先插入）
    meta = Base.metadata
    order = ["novels"] + EXPORT_TABLES
    try:
        for tname in order:
            t = meta.tables[tname]
            for r in tables.get(tname) or []:
                nr = _rebuild_row(t, r, all_idmap, new_novel_id, old_novel_id, tname)
                db.execute(t.insert().values(**nr))
        db.commit()
    except Exception as e:
        db.rollback()
        raise ValueError(f"导入失败：{e}") from e
    return new_novel_id
