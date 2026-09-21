"""chapter_versions add title + outline_id

章节版本级元数据（草稿→手动定稿模式）：
- title：每个版本自己的标题（草稿可各自不同，定稿时同步回章节）；
- outline_id：该版本正文所用的大纲版本（同章不同版本内容可能不同，关联精确到版本）。

Revision ID: a1b2c3d4e5f6
Revises: 9a1b2c3d4e5f
Create Date: 2026-09-21 18:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = '9a1b2c3d4e5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('chapter_versions') as batch_op:
        batch_op.add_column(sa.Column('title', sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column('outline_id', sa.Uuid(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('chapter_versions') as batch_op:
        batch_op.drop_column('outline_id')
        batch_op.drop_column('title')
