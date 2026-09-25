"""add author_confirms

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-09-25

作者确认机制：生成流程内的暂停点表。agent 遇到需作者定夺的岔路口（大纲发展脉络方向/
时代研究结论/背景×题材校验）落一条 pending 请求，前端弹窗让作者选择，提交后恢复生成。
"""
import sqlalchemy as sa

from alembic import op

revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "author_confirms",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("novel_id", sa.Uuid(), sa.ForeignKey("novels.id"), nullable=False, index=True),
        sa.Column("agent", sa.String(64), nullable=False, index=True),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("agent_tasks.id"), nullable=True, index=True),
        sa.Column("confirm_key", sa.String(64), nullable=False, index=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("options", sa.JSON(), nullable=True),
        sa.Column("allow_custom", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("answer_meta", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("answered_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("author_confirms")
