"""角色注册表：角色统一注册，编排层按名取用（加角色 = 注册一个类）。"""
from sqlalchemy.orm import Session

from app.agents.base import Agent
from app.agents.blueprint_architect import BlueprintArchitectAgent
from app.agents.critic import CriticAgent
from app.agents.extractor import ExtractorAgent
from app.agents.import_checker import ImportCheckerAgent
from app.agents.memory_keeper import MemoryKeeperAgent
from app.agents.novelist import NovelistAgent
from app.agents.outline_checker import OutlineCheckerAgent
from app.agents.outliner import OutlinerAgent
from app.agents.reviser import ReviserAgent
from app.agents.setting_extractor import SettingExtractorAgent
from app.agents.style_extractor import StyleExtractorAgent

REGISTRY: dict[str, type[Agent]] = {
    "setting_extractor": SettingExtractorAgent,
    "blueprint_architect": BlueprintArchitectAgent,
    "outliner": OutlinerAgent,
    "novelist": NovelistAgent,
    "extractor": ExtractorAgent,
    "critic": CriticAgent,
    "reviser": ReviserAgent,
    "memory_keeper": MemoryKeeperAgent,  # 作品编年总览（每 N 章生成，长期记忆注入）
    "import_checker": ImportCheckerAgent,
    "style_extractor": StyleExtractorAgent,
    "outline_checker": OutlineCheckerAgent,
}

AGENT_NAMES = list(REGISTRY.keys())


def get_agent(db: Session, name: str) -> Agent:
    if name not in REGISTRY:
        raise KeyError(f"未知角色：{name}（可选：{', '.join(AGENT_NAMES)}）")
    return REGISTRY[name](db)
