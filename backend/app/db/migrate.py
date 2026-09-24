"""开发期轻量迁移：SQLite 旧库补列（生产走 Alembic 正式迁移）。

Base.metadata.create_all 只会新建缺失的【表】，不会为已存在的表补列。
此处对 M2/M3/M4 新增的 nullable 列做幂等 ALTER TABLE ADD COLUMN。
"""
import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

# 表名 -> [(列名, DDL 类型)]；DDL 类型为 SQLite 语法（JSON 用 TEXT 表达）
_ADD_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "novels": [
        ("style_directive", "TEXT"),
        ("style_directive_manual", "TEXT"),
        ("background_type", "VARCHAR(16) NOT NULL DEFAULT 'realistic'"),  # 世界背景类型：realistic|alternate|pure_fantasy
        ("genres", "JSON"),  # 题材多选：软性写作方向指引，如 ["都市","重生"]
    ],
    "settings": [
        ("aliases", "TEXT"),
        ("merged_into_id", "CHAR(36)"),
        ("source", "VARCHAR(16) NOT NULL DEFAULT 'manual'"),
        ("outline_ids", "TEXT"),  # 大纲批准时注入的角色设定：来源大纲版本（可多值，跨章多个），任一来源仍批准即可见
        ("is_pinned", "BOOLEAN NOT NULL DEFAULT 0"),  # 关键信息固化：AI 判定为关键时置 1，注入不受数量上限影响
    ],
    "plot_ledger": [
        ("since_chapter", "INTEGER"),
        ("invalidated_at_chapter", "INTEGER"),
        ("source", "VARCHAR(16) NOT NULL DEFAULT 'outline'"),  # 数据来源（隐形）：outline|extractor|manual
        ("outline_id", "CHAR(36)"),  # 来源大纲版本 id（source=outline 时，隐形字段不展示）
        ("is_pinned", "BOOLEAN NOT NULL DEFAULT 0"),  # 关键信息固化：importance=high 的伏笔置 1，注入不受 20 条上限影响
    ],
    "chapter_versions": [
        ("title", "VARCHAR(255)"),  # 该版本自己的标题（草稿各自独立，定稿时同步回章）
        ("outline_id", "CHAR(36)"),  # 该版本正文所用的大纲版本 id
        ("parent_version_id", "CHAR(36)"),  # 版本树父节点：评价优化产物挂到被优化版本下（多级树）
        ("signing_blocked", "BOOLEAN NOT NULL DEFAULT 0"),  # 签约未过签标记：最新评价含高危红线 issue 时为 1，定稿默认拒绝
    ],
    "story_state": [
        ("since_chapter", "INTEGER"),
        ("invalidated_at_chapter", "INTEGER"),
    ],
    "blueprints": [
        ("source_doc", "TEXT"),
        ("doc_name", "TEXT"),
    ],
    "entity_relations": [
        ("archived", "BOOLEAN NOT NULL DEFAULT 0"),
        ("superseded_by_chapter", "INTEGER"),
        ("superseded_by_relation", "TEXT"),
    ],
}


def ensure_columns(engine: Engine) -> None:
    """为已存在的表补齐新增列（幂等）。"""
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    for table, cols in _ADD_COLUMNS.items():
        if table not in existing_tables:
            continue
        existing_cols = {c["name"] for c in inspector.get_columns(table)}
        with engine.begin() as conn:
            for col, ddl in cols:
                if col in existing_cols:
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
                logger.info("迁移：%s 表补列 %s", table, col)


def ensure_prompts_schema(engine: Engine) -> None:
    """prompts 表从「key 单列唯一」升级为「key+scope 联合唯一」。

    写作指令改为按小说独立后，同一 key（角色）会在不同 scope（novel:{id}）下有多行，
    单列唯一约束会冲突。开发期幂等迁移：检测到旧约束就重建表（仅存配置，旧 global 行可丢弃）。
    """
    inspector = inspect(engine)
    if "prompts" not in set(inspector.get_table_names()):
        return
    for ix in inspector.get_indexes("prompts"):
        if ix.get("unique") and tuple(ix["column_names"]) == ("key", "scope"):
            return  # 已是联合唯一
    logger.info("迁移：重建 prompts 表（key 单列唯一 -> key+scope 联合唯一）")
    from app.db.base import Base

    table = Base.metadata.tables["prompts"]
    table.drop(bind=engine, checkfirst=True)
    table.create(bind=engine)
