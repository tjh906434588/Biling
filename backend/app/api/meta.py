"""元数据字典接口：角色名 / 任务类型 / 题材别名等枚举数据按 key 聚合下发。

前端统一经 GET /api/meta 拉取并做本地缓存（命中缓存不再请求，省开销），
避免每个枚举一个接口、前端多处维护副本导致漂移。
新增枚举字典 = 在 DICT_BUILDERS 注册一个构建函数 + key。
"""
from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/meta", tags=["meta"])

# 任务类型清单（key + label + hint，文案单一源）。
# 排序按创作流水线：设定（地基）→ 质检（把关）→ 规划（正文前置细化）→ 创作（正文）→ 提取（每章记忆）→ 评价（审稿收尾）→ 编年（跨章压缩）
TASK_TYPES: list[dict[str, str]] = [
    {"key": "setting", "label": "设定", "hint": "规划世界观、人物与大章节大纲，定下故事骨架"},
    {"key": "check", "label": "质检", "hint": "校验大纲、蓝图与导入内容是否达标合规"},
    {"key": "planning", "label": "规划", "hint": "写正文前细化本章规划（章节/场景），作者确认后开写"},
    {"key": "creation", "label": "创作", "hint": "写每一章的正文内容"},
    {"key": "extract", "label": "提取", "hint": "把已写的章节自动整理成剧情要点和人物信息，供后续写作参考"},
    {"key": "review", "label": "评价", "hint": "审读章节质量，发现问题并给出修改建议"},
    {"key": "chronicle", "label": "编年", "hint": "定期把前文浓缩成故事脉络，防止写久了忘掉早期伏笔"},
]


def _roles_by_task_type() -> dict[str, list[str]]:
    """按 task_type 聚合角色中文名：遍历角色注册表，取其 task_type 与中文名分组。"""
    from app.agents.registry import REGISTRY
    from app.agents.roles import ROLE_NAMES

    groups: dict[str, list[str]] = {}
    for agent_key, agent_cls in REGISTRY.items():
        tt = getattr(agent_cls, "task_type", "setting")
        groups.setdefault(tt, []).append(ROLE_NAMES.get(agent_key, agent_key))
    return groups


def _build_task_types() -> list[dict[str, object]]:
    """任务类型 + 该类型下的角色中文名（角色列表动态聚合，新增角色自动反映）。"""
    roles = _roles_by_task_type()
    return [{**t, "roles": roles.get(t["key"], [])} for t in TASK_TYPES]


def _build_agents() -> dict[str, str]:
    """角色中文名（roles.py 单一源）。"""
    from app.agents.roles import ROLE_NAMES

    return dict(ROLE_NAMES)


def _build_genre_aliases() -> dict[str, str]:
    """题材同义标签 → 标准标签（platform_rules 单一源）。"""
    from app.agents.platform_rules import GENRE_ALIASES

    return dict(GENRE_ALIASES)


def _build_chapter_functions() -> list[dict[str, str]]:
    """章节节奏功能下拉项（value + 中文 label）。
    value 集合与 schemas/agents.py 的 CHAPTER_FUNCTIONS 一致（LLM 输出约束）；
    中文 label 全项目统一经此下发（大纲页/写作页下拉、规划确认展示共用一份，不再各自维护）。
    """
    return [
        {"value": "progression", "label": "推进"},
        {"value": "buildup", "label": "铺垫"},
        {"value": "turning", "label": "转折"},
        {"value": "climax", "label": "高潮"},
        {"value": "revelation", "label": "揭秘"},
        {"value": "resolution", "label": "收束"},
        {"value": "interlude", "label": "间奏"},
    ]


DICT_BUILDERS: dict[str, object] = {
    "agents": _build_agents,
    "task_types": _build_task_types,
    "genre_aliases": _build_genre_aliases,
    "chapter_functions": _build_chapter_functions,
}


@router.get("")
def get_meta(keys: str = Query(default="", description="逗号分隔的字典 key；空 = 返回全部")) -> dict[str, object]:
    """按 key 返回枚举字典；未指定 key 时返回全部。前端带缓存按需取用。"""
    wanted = {k.strip() for k in keys.split(",") if k.strip()} if keys else set(DICT_BUILDERS)
    return {k: DICT_BUILDERS[k]() for k in wanted if k in DICT_BUILDERS}
