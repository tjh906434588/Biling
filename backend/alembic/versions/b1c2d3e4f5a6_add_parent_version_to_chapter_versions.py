"""chapter_versions add parent_version_id

版本树：新增章节/重新生成正文的版本为根（parent_version_id=null）；
评价优化（reviser）产物挂到被优化版本之下（parent_version_id=被优化版本 id），
可沿评价→优化无限递归，形成多级版本树（前端以多级无序列表展示）。

Revision ID: b1c2d3e4f5a6
Revises: a1b2c3d4e5f6
Create Date: 2026-09-21 19:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('chapter_versions') as batch_op:
        batch_op.add_column(sa.Column('parent_version_id', sa.Uuid(), nullable=True))
        batch_op.create_index('ix_chapter_versions_parent_version_id', ['parent_version_id'])


def downgrade() -> None:
    with op.batch_alter_table('chapter_versions') as batch_op:
        batch_op.drop_index('ix_chapter_versions_parent_version_id')
        batch_op.drop_column('parent_version_id')
