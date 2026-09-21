"""plot_ledger add source + outline_id

账本数据来源与版本标记（隐形字段，不展示界面）：
- source：outline（大纲批准时注入）| extractor（提取师）| manual（手动登记），默认 outline；
- outline_id：source="outline" 时记录登记它的大纲版本 id。

版本语义与设定一致：大纲来源的账本只显示「来源版本仍批准」的行，
切版本后隐藏（不删除，切回恢复）；其余来源恒显示。

Revision ID: 9a1b2c3d4e5f
Revises: 8a2b3c4d5e6f
Create Date: 2026-09-21 16:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '9a1b2c3d4e5f'
down_revision: Union[str, None] = '8a2b3c4d5e6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('plot_ledger') as batch_op:
        batch_op.add_column(sa.Column('source', sa.String(length=16), server_default='outline', nullable=False))
        batch_op.add_column(sa.Column('outline_id', sa.Uuid(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('plot_ledger') as batch_op:
        batch_op.drop_column('outline_id')
        batch_op.drop_column('source')
