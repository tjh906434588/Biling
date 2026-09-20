"""blueprint two-state + versioned settings/style

蓝图状态机收敛为两态：draft|archived → inactive（未生效），保留 active（生效中）。
设定/风格按蓝图版本存储：settings 加 blueprint_id 归属列；新增 blueprint_styles 表。

Revision ID: 6a2b3c4d5e6f
Revises: 5a1b2c3d4e5f
Create Date: 2026-09-20 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '6a2b3c4d5e6f'
down_revision: Union[str, None] = '5a1b2c3d4e5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) 蓝图状态收敛两态：draft / archived → inactive
    op.execute("UPDATE blueprints SET status = 'inactive' WHERE status IN ('draft', 'archived')")

    # 2) settings 增加蓝图归属列（source="blueprint" 的设定记录导入它的蓝图）
    #    SQLite 不支持 ALTER 直接加外键，需用 batch（重建表）模式
    with op.batch_alter_table('settings') as batch_op:
        batch_op.add_column(sa.Column('blueprint_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            'fk_settings_blueprint', 'blueprints',
            ['blueprint_id'], ['id'], ondelete='SET NULL',
        )
        batch_op.create_index(op.f('ix_settings_blueprint_id'), ['blueprint_id'], unique=False)

    # 存量回填：把旧「蓝图导入」设定归属到该书生效蓝图；无生效蓝图则归属最新版本
    op.execute(
        """
        UPDATE settings
        SET blueprint_id = (
            SELECT b.id FROM blueprints b
            WHERE b.novel_id = settings.novel_id
              AND b.status = 'active'
            ORDER BY b.version DESC
            LIMIT 1
        )
        WHERE source = 'blueprint' AND blueprint_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE settings
        SET blueprint_id = (
            SELECT b.id FROM blueprints b
            WHERE b.novel_id = settings.novel_id
            ORDER BY b.version DESC
            LIMIT 1
        )
        WHERE source = 'blueprint' AND blueprint_id IS NULL
        """
    )

    # 3) 蓝图识别文风按版本存储
    op.create_table(
        'blueprint_styles',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('blueprint_id', sa.Uuid(), nullable=False),
        sa.Column('novel_id', sa.Uuid(), nullable=False),
        sa.Column('directive', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['blueprint_id'], ['blueprints.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['novel_id'], ['novels.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('blueprint_id'),
    )
    op.create_index(op.f('ix_blueprint_styles_blueprint_id'), 'blueprint_styles', ['blueprint_id'], unique=True)
    op.create_index(op.f('ix_blueprint_styles_novel_id'), 'blueprint_styles', ['novel_id'], unique=False)

    # 存量回填：把旧全局文风沉淀为「当前生效蓝图」的文风（无生效蓝图则最新版本），
    # 保证切回任意版本时都能拿到对应文风
    op.execute(
        """
        INSERT INTO blueprint_styles (id, blueprint_id, novel_id, directive)
        SELECT lower(hex(randomblob(16))), b.id, b.novel_id, n.style_directive
        FROM blueprints b
        JOIN novels n ON n.id = b.novel_id
        WHERE b.status = 'active'
          AND n.style_directive IS NOT NULL
          AND trim(n.style_directive) <> ''
          AND NOT EXISTS (
              SELECT 1 FROM blueprint_styles bs WHERE bs.blueprint_id = b.id
          )
        """
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_blueprint_styles_novel_id'), table_name='blueprint_styles')
    op.drop_index(op.f('ix_blueprint_styles_blueprint_id'), table_name='blueprint_styles')
    op.drop_table('blueprint_styles')

    with op.batch_alter_table('settings') as batch_op:
        batch_op.drop_index(op.f('ix_settings_blueprint_id'))
        batch_op.drop_constraint('fk_settings_blueprint', type_='foreignkey')
        batch_op.drop_column('blueprint_id')

    # 无法精确还原原三态，回退为最接近的语义：inactive → draft
    op.execute("UPDATE blueprints SET status = 'draft' WHERE status = 'inactive'")
