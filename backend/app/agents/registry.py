"""角色注册表：角色统一注册，编排层按名取用（加角色 = 注册一个类）。"""
from sqlalchemy.orm import Session

from app.agents.base import Agent
from app.agents.blueprint_architect import BlueprintArchitectAgent
from app.agents.blueprint_prechecker import BlueprintPrecheckerAgent
from app.agents.critic import CriticAgent
from app.agents.chapter_planner import ChapterPlannerAgent
from app.agents.direction_proposer import DirectionProposerAgent
from app.agents.era_researcher import EraResearcherAgent
from app.agents.extractor import ExtractorAgent
from app.agents.import_checker import ImportCheckerAgent
from app.agents.memory_keeper import MemoryKeeperAgent
from app.agents.novelist import NovelistAgent
from app.agents.outline_checker import OutlineCheckerAgent
from app.agents.outliner import OutlinerAgent
from app.agents.reviser import ReviserAgent
from app.agents.scene_planner import ScenePlannerAgent
from app.agents.setting_extractor import SettingExtractorAgent
from app.agents.style_extractor import StyleExtractorAgent

REGISTRY: dict[str, type[Agent]] = {
    "setting_extractor": SettingExtractorAgent,
    "blueprint_architect": BlueprintArchitectAgent,
    "blueprint_prechecker": BlueprintPrecheckerAgent,  # 蓝图导入质检师（导入前找文档内部疑点，弹窗问作者怎么处理）
    "outliner": OutlinerAgent,
    "novelist": NovelistAgent,
    "extractor": ExtractorAgent,
    "critic": CriticAgent,
    "reviser": ReviserAgent,
    "memory_keeper": MemoryKeeperAgent,  # 作品编年总览（每 N 章生成，长期记忆注入）
    "import_checker": ImportCheckerAgent,
    "style_extractor": StyleExtractorAgent,
    "outline_checker": OutlineCheckerAgent,
    "era_researcher": EraResearcherAgent,  # 时代行业研究员（生成蓝图前自动研究，落库 novel.era_research）
    "direction_proposer": DirectionProposerAgent,  # 大纲方向提案师（生成大纲前咨询作者下一步发展脉络，产出 3 个方向候选）
    "chapter_planner": ChapterPlannerAgent,  # 章节规划师（写正文前咨询作者「本章规划」，产出 3 套完整规划候选）
    "scene_planner": ScenePlannerAgent,  # 场景规划师（10 维度定稿后把本章拆成 3-5 个场景逐字段确认；每场景扩写前生成 5 个写法提案）
}

AGENT_NAMES = list(REGISTRY.keys())


def get_agent(db: Session, name: str) -> Agent:
    if name not in REGISTRY:
        raise KeyError(f"未知角色：{name}（可选：{', '.join(AGENT_NAMES)}）")
    return REGISTRY[name](db)
