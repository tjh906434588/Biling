"""开发期轻量迁移：SQLite 旧库补列（生产走 Alembic 正式迁移）。

Base.metadata.create_all 只会新建缺失的【表】，不会为已存在的表补列。
此处对历次新增的 nullable 列做幂等 ALTER TABLE ADD COLUMN。
"""
import json
import logging
from datetime import datetime

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

# 表名 -> [(列名, DDL 类型)]；DDL 类型为 SQLite 语法（JSON 用 TEXT 表达）
_ADD_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "novels": [
        ("style_directive", "TEXT"),
        ("style_directive_manual", "TEXT"),
        ("background_type", "VARCHAR(16)"),  # 世界背景类型：可空，未选择（导入蓝图时 AI 推断、作者确认后落库）
        ("genres", "JSON"),  # 题材多选：软性写作方向指引，如 ["都市","重生"]
        ("era_research", "JSON"),  # 时代行业研究（运行时按需生成，作者可改）：机构形态/老板画像/业务/演进/时代雷点
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
    "chapters": [
        ("author_directives", "TEXT"),  # 作者对本章的历史修改意见（JSON list[{text,version_no,created_at}]），后续生成自动注入
        ("info_control", "JSON"),  # 本章信息控制（谁知道了什么）：{reader_knows, protagonist_knows, must_hide, hint_only}
    ],
    "chapter_versions": [
        ("info_control", "JSON"),  # 生成该版本时生效的信息控制快照
    ],
    "story_state": [
        ("since_chapter", "INTEGER"),
        ("invalidated_at_chapter", "INTEGER"),
    ],
    "blueprints": [
        ("source_doc", "TEXT"),
        ("doc_name", "TEXT"),
    ],
    "author_confirms": [
        ("fields", "JSON"),  # 场景卡片确认：fields=[{field,label,hint,options}]（场景规划逐字段单选）
        ("regenerable", "BOOLEAN NOT NULL DEFAULT 0"),  # 场景写法提案确认：前端提供「都不满意，重新生成」按钮
    ],
    "entity_relations": [
        ("archived", "BOOLEAN NOT NULL DEFAULT 0"),
        ("superseded_by_chapter", "INTEGER"),
        ("superseded_by_relation", "TEXT"),
    ],
    "novels": [
        ("info_control", "JSON"),  # 本书级信息控制（谁知道了什么）：{reader_knows, protagonist_knows, must_hide, hint_only}
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


def ensure_novel_background_type_nullable(engine: Engine) -> None:
    """旧库 novels.background_type 为 NOT NULL DEFAULT 'realistic'，无法表示「未选择」。
    SQLite 不支持 ALTER COLUMN 改约束，重建该表为 NULLABLE（无默认值）。
    SQLite 外键未启用，重建安全；幂等：列已可空则跳过（全新库/已迁移）。"""
    inspector = inspect(engine)
    if "novels" not in set(inspector.get_table_names()):
        return
    col_nullable = True
    for col in inspector.get_columns("novels"):
        if col["name"] == "background_type":
            col_nullable = bool(col.get("nullable", True))
            break
    if col_nullable:
        return
    logger.info("迁移：重建 novels 表，background_type 改为可空（支持「未选择」）")
    from app.db.base import Base

    with engine.begin() as conn:
        conn.execute(text("PRAGMA foreign_keys=OFF"))
        conn.execute(text("ALTER TABLE novels RENAME TO novels_old"))
        Base.metadata.tables["novels"].create(bind=conn, checkfirst=False)
        conn.execute(text(
            "INSERT INTO novels (id, title, premise, style_directive, style_directive_manual, "
            "background_type, genres, era_research, created_at, updated_at) "
            "SELECT id, title, premise, style_directive, style_directive_manual, "
            "background_type, genres, era_research, created_at, updated_at FROM novels_old"
        ))
        conn.execute(text("DROP TABLE novels_old"))


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


def ensure_timestamps_local(engine: Engine) -> None:
    """旧库时间换算：历史 created_at/updated_at 等此前存的是 UTC
    （server_default=func.now()，SQLite CURRENT_TIMESTAMP 返回 UTC），
    一次性换算为本地时间（SQLite datetime(col, 'localtime') 按机器时区转换）。
    models 的时间默认值已统一为本地时间（datetime.now()），此迁移只为对齐存量数据。

    幂等：以 app_preferences 的标记键为准，换算完成写入标记，重复启动不重复换算。
    只处理 DATETIME/DATE 类型列，跳过 NULL/空串/不可解析值，不触碰其它类型列。
    """
    marker_key = "__timestamps_local_migrated_v1"
    with engine.connect() as conn:
        tables = {
            r[0]
            for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
        if not tables or "app_preferences" not in tables:
            return
        done = conn.execute(
            text("SELECT 1 FROM app_preferences WHERE key = :k"), {"k": marker_key}
        ).fetchone()
    if done:
        return
    logger.info("迁移：历史时间列由 UTC 换算为本地时间（一次性，仅旧库有数据时生效）")
    with engine.begin() as conn:
        for table in tables:
            cols = conn.execute(text(f'PRAGMA table_info("{table}")')).fetchall()
            dt_cols = [
                r[1] for r in cols if str(r[2]).upper() in ("DATETIME", "DATE")
            ]
            for col in dt_cols:
                conn.execute(text(
                    f'UPDATE "{table}" SET "{col}" = datetime("{col}", "localtime") '
                    f'WHERE "{col}" IS NOT NULL AND "{col}" != "" '
                    f'AND datetime("{col}") IS NOT NULL'
                ))
        conn.execute(
            text(
                "INSERT INTO app_preferences (key, value, updated_at) "
                "VALUES (:k, :v, :ts) ON CONFLICT(key) DO NOTHING"
            ),
            {"k": marker_key, "v": json.dumps({"done": True}), "ts": datetime.now().isoformat(timespec="seconds")},
        )
