"""角色中文名唯一权威源（单一维护点）。

全项目（写作指令弹窗、任务通知、确认弹窗、调试页、模型路由对照）的角色中文名
一律从这里取，禁止在其他文件再各自维护一份中文名，避免同一角色多处叫法漂移。
命名以作者确认的「任务类型 × 角色」对照表为准。

新增角色 = 注册到 agents/registry.py + 在本文件补一条中文名。
"""
from __future__ import annotations

ROLE_NAMES: dict[str, str] = {
    # setting：创意规划、世界观搭建
    "blueprint_architect": "蓝图架构师",
    "outliner": "大纲师",
    "direction_proposer": "提案师",
    "era_researcher": "研究员",
    # check：质检、合规把关
    "blueprint_prechecker": "蓝图导入质检师",
    "import_checker": "导入质检师",
    "outline_checker": "大纲质检师",
    # planning：结构化细化、合规输出
    "chapter_planner": "章节规划师",
    "scene_planner": "场景规划师",
    # creation：正文创作与修订
    "novelist": "小说家",
    "reviser": "修订师",
    # extract：记忆抽取、状态追踪
    "extractor": "状态提取师",
    "setting_extractor": "设定提取师",
    "style_extractor": "文风提取师",
    # review：质量审稿、逻辑校验
    "critic": "评价师",
    # chronicle：长期记忆压缩、编年
    "memory_keeper": "作品编年师",
}
