"""add era_research to novels

Revision ID: e5f6a7b8c9d0
Revises: d1e2f3a4b5c6
Create Date: 2026-09-24

时代行业研究（运行时按需生成）落库字段：机构形态/老板画像/业务清单/位置规律/行业演进/时代雷点。
"""
import sqlalchemy as sa

from alembic import op

revision = "e5f6a7b8c9d0"
down_revision = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("novels", sa.Column("era_research", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("novels", "era_research")
