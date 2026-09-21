"""outlines add version_no

章节大纲支持轻量历史版本：同一章可存多个版本（version_no 递增），
批准版是下游唯一依据。生成新大纲时不再覆盖删除旧版，而是插入新版本。

Revision ID: 7a1b2c3d4e5f
Revises: 6a2b3c4d5e6f
Create Date: 2026-09-21 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '7a1b2c3d4e5f'
down_revision: Union[str, None] = '6a2b3c4d5e6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SQLite 不支持 ALTER 直接加带默认值的列，需用 batch 模式
    with op.batch_alter_table('outlines') as batch_op:
        batch_op.add_column(sa.Column('version_no', sa.Integer(), nullable=False, server_default='1'))
        batch_op.create_index(op.f('ix_outlines_chapter_no_version'), ['chapter_no', 'version_no'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('outlines') as batch_op:
        batch_op.drop_index(op.f('ix_outlines_chapter_no_version'))
        batch_op.drop_column('version_no')
