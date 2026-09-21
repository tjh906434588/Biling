"""settings add outline_ids

大纲批准时把该版大纲登场且设定库没有的角色注入设定库（source="outline"）。
outline_ids 记录注入来源的大纲版本（第几章第几个版本，可跨章多值，隐形字段不展示）：
只要任一来源版本仍是「该章当前批准版」该设定即可见；全部来源不再批准时隐藏（不删除，切回可恢复）。

Revision ID: 8a2b3c4d5e6f
Revises: 7a1b2c3d4e5f
Create Date: 2026-09-21 15:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '8a2b3c4d5e6f'
down_revision: Union[str, None] = '7a1b2c3d4e5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('settings') as batch_op:
        batch_op.add_column(sa.Column('outline_ids', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('settings') as batch_op:
        batch_op.drop_column('outline_ids')
