"""add extracted version to story_state

Revision ID: 5a1b2c3d4e5f
Revises: 360155aea244
Create Date: 2026-09-18 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '5a1b2c3d4e5f'
down_revision: Union[str, None] = '360155aea244'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # story_state 记录「提取时对应的正文版本」，用于前端判断当前版本是否已提取过记忆层
    # SQLite 不支持 ALTER 加外键，需用 batch（重建表）模式
    with op.batch_alter_table('story_state') as batch_op:
        batch_op.add_column(sa.Column('chapter_version_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            'fk_story_state_chapter_version', 'chapter_versions',
            ['chapter_version_id'], ['id'],
        )
    # 存量回填：把每章已提取的 story_state 关联到该章当前激活版本（提取时通常就是激活版本；
    # 若之后版本已更新，前端会判定「不一致」→ 提醒重提取，行为与设计一致）。
    op.execute(
        """
        UPDATE story_state
        SET chapter_version_id = (
            SELECT cv.id FROM chapter_versions cv
            JOIN chapters c ON c.id = cv.chapter_id
            WHERE c.novel_id = story_state.novel_id
              AND c.chapter_no = story_state.chapter_no
              AND cv.is_active = 1
            LIMIT 1
        )
        WHERE chapter_version_id IS NULL
        """
    )


def downgrade() -> None:
    with op.batch_alter_table('story_state') as batch_op:
        batch_op.drop_constraint('fk_story_state_chapter_version', type_='foreignkey')
        batch_op.drop_column('chapter_version_id')
