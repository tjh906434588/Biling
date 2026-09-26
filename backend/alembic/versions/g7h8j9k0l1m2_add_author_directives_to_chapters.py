"""add author_directives to chapters

Revision ID: g7h8j9k0l1m2
Revises: f6a7b8c9d0e1
Create Date: 2026-09-26

意见持久化：作者在「评价优化」时提交的批注（author_note）落库到章节级 author_directives，
后续重新生成/规划/续写本章时自动注入给 AI（novelist / chapter_planner 的 build_context），
防止"说了突兀还照写"。结构：JSON list[{text, version_no, created_at}]。
"""
import sqlalchemy as sa

from alembic import op

revision = "g7h8j9k0l1m2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("chapters", sa.Column("author_directives", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("chapters", "author_directives")
