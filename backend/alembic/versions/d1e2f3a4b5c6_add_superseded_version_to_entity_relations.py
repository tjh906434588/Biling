"""add superseded_by_version to entity_relations

Revision ID: d1e2f3a4b5c6
Revises: c1d2e3f4a5b6
Create Date: 2026-09-22 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd1e2f3a4b5c6'
down_revision: Union[str, None] = 'c1d2e3f4a5b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # entity_relations 记录「取代者提取时所在的正文版本」：取代标记（archived）本身与版本无关，
    # 但注入/展示层需要知道「取代发生在哪个正文版本上」——切回旧版本（取代者版本不激活）时，
    # 被取代的旧关系应「复活」显示，消除取代链跨版本空档（旧关系与取代者同时被过滤）。
    # SQLite 不支持 ALTER 加外键，需用 batch（重建表）模式
    with op.batch_alter_table('entity_relations') as batch_op:
        batch_op.add_column(sa.Column('superseded_by_version', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            'fk_entity_relations_superseded_version', 'chapter_versions',
            ['superseded_by_version'], ['id'],
        )
    # 存量回填：被取代的旧关系，superseded_by_version 指向「取代者所在章（superseded_by_chapter）」
    # 当前激活版本（取代发生时通常就是当时的激活版本）。
    op.execute(
        """
        UPDATE entity_relations
        SET superseded_by_version = (
            SELECT cv.id FROM chapter_versions cv
            JOIN chapters c ON c.id = cv.chapter_id
            WHERE c.novel_id = entity_relations.novel_id
              AND c.chapter_no = entity_relations.superseded_by_chapter
              AND cv.is_active = 1
            LIMIT 1
        )
        WHERE archived = 1
          AND superseded_by_chapter IS NOT NULL
          AND superseded_by_version IS NULL
        """
    )


def downgrade() -> None:
    with op.batch_alter_table('entity_relations') as batch_op:
        batch_op.drop_constraint('fk_entity_relations_superseded_version', type_='foreignkey')
        batch_op.drop_column('superseded_by_version')
