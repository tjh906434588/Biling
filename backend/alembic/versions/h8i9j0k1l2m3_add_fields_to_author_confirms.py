"""add fields & regenerable to author_confirms

Revision ID: h8i9j0k1l2m3
Revises: g7h8j9k0l1m2
Create Date: 2026-09-26

场景规划（10 维度定稿后拆场景逐字段确认）：
- author_confirms.fields：场景卡片确认的字段候选（JSON list[{field,label,hint,options}]），
  存在时前端按「场景卡片」渲染（每字段单选+自定义），答案回传 field_answers；
- author_confirms.regenerable：场景写法提案确认标记，前端提供「都不满意，重新生成」按钮（回传 __regenerate__）。
"""
import sqlalchemy as sa

from alembic import op

revision = "h8i9j0k1l2m3"
down_revision = "g7h8j9k0l1m2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("author_confirms", sa.Column("fields", sa.JSON(), nullable=True))
    op.add_column(
        "author_confirms", sa.Column("regenerable", sa.Boolean(), nullable=False, server_default=sa.false())
    )


def downgrade() -> None:
    op.drop_column("author_confirms", "regenerable")
    op.drop_column("author_confirms", "fields")
