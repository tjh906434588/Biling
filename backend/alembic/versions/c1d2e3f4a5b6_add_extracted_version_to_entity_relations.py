"""add extracted version to entity_relations

Revision ID: c1d2e3f4a5b6
Revises: b1c2d3e4f5a6
Create Date: 2026-09-21 15:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c1d2e3f4a5b6'
down_revision: Union[str, None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # entity_relations 记录「该 dynamic 关系对应的正文版本」，用于注入时按当前激活版本过滤，
    # 防止切换版本后残留旧版人物关系（与 story_state.chapter_version_id 同一套版本校验）。
    # SQLite 不支持 ALTER 加外键，需用 batch（重建表）模式
    with op.batch_alter_table('entity_relations') as batch_op:
        batch_op.add_column(sa.Column('chapter_version_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            'fk_entity_relations_chapter_version', 'chapter_versions',
            ['chapter_version_id'], ['id'],
        )
    # 存量回填：把已有 dynamic 关系关联到该章当前激活版本（提取时通常就是激活版本；
    # 若之后版本已更新，注入层会判定「不一致」→ 跳过注入，行为与 story_state 一致）。
    op.execute(
        """
        UPDATE entity_relations
        SET chapter_version_id = (
            SELECT cv.id FROM chapter_versions cv
            JOIN chapters c ON c.id = cv.chapter_id
            WHERE c.novel_id = entity_relations.novel_id
              AND c.chapter_no = entity_relations.chapter_no
              AND cv.is_active = 1
            LIMIT 1
        )
        WHERE chapter_version_id IS NULL
        """
    )


def downgrade() -> None:
    with op.batch_alter_table('entity_relations') as batch_op:
        batch_op.drop_constraint('fk_entity_relations_chapter_version', type_='foreignkey')
        batch_op.drop_column('chapter_version_id')
