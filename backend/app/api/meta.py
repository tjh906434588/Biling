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


def _build_setting_types() -> list[dict[str, str]]:
    """设定类型规格（key + label/hint/示例/判定标准/填写建议）：设定表单与类型栏的单一源。
    key 集合与 schemas/agents.py / schemas/novel.py 的设定类型约束一致。"""
    return [
        {
            "key": "character", "label": "角色", "hint": "谁在故事里",
            "example": "岚：沉默的占卜师，左眼能看到死者的记忆",
            "judge": "会说话、有自我意识的（活物/系统有嘴也算）",
            "name_hint": "岚",
            "desc_hint": "如：左眼能看到死者记忆的占卜师，沉默寡言",
            "constitution_advice": "性别/身份/血统/异能来源填「不可变」；性格成长填「可变」，交给记忆层跟踪。",
        },
        {
            "key": "location", "label": "地点", "hint": "故事发生在哪",
            "example": "旧王城：雾都，占卜房藏在第七街尽头",
            "judge": "在哪：故事发生的场所",
            "name_hint": "旧王城",
            "desc_hint": "如：常年起雾，占卜房藏在第七街尽头",
            "constitution_advice": "本质（位置、特征）填「不可变」；当前状态（被毁、废弃、易主）填「可变」。",
        },
        {
            "key": "faction", "label": "势力", "hint": "组织 / 家族 / 阵营",
            "example": "灰袍议会：暗中篡改王城记忆的组织",
            "judge": "组织：家族/帮派/阵营",
            "name_hint": "灰袍议会",
            "desc_hint": "如：暗中篡改王城记忆的组织，首领身份不明",
            "constitution_advice": "宗旨、根基填「不可变」；当前强弱、首领、敌友关系填「可变」。",
        },
        {
            "key": "world_rule", "label": "世界规则", "hint": "这个世界的法则",
            "example": "魔法消耗寿命，且不可逆转",
            "judge": "法则：所有角色都遵守（如人人都有系统）",
            "name_hint": "魔法耗尽寿命",
            "desc_hint": "如：用一次魔法就折损一段寿命，不可逆转",
            "constitution_advice": "世界法则基本都填「不可变」——违背即崩，AI 必须死守。",
        },
        {
            "key": "item", "label": "物品", "hint": "有来历的道具 / 宝物",
            "example": "旧王徽铜币：遇险会发烫，认得主人",
            "judge": "道具：实体的、拿得到的",
            "name_hint": "旧王徽铜币",
            "desc_hint": "如：遇险会发烫，只认主人",
            "constitution_advice": "核心功能、限制填「不可变」；在谁手里、是否损坏填「可变」。",
        },
        {
            "key": "concept", "label": "概念", "hint": "世界观里的特有名词",
            "example": "记忆刻印：记忆可以被人为写入和抹除",
            "judge": "特有名词/机制（如主角独有的系统）",
            "name_hint": "记忆刻印",
            "desc_hint": "如：记忆可以被人为写入和抹除",
            "constitution_advice": "概念的定义是恒定名词，基本都填「不可变」。",
        },
    ]


def _build_role_ranks() -> list[dict[str, str]]:
    """视角角色按戏份分组（value + 中文 label，与设定库 role_rank 一致）。"""
    return [
        {"value": "protagonist", "label": "主角"},
        {"value": "major", "label": "重要配角"},
        {"value": "minor", "label": "次要配角"},
        {"value": "extra", "label": "龙套 / 炮灰"},
    ]


def _build_stages() -> list[dict[str, str]]:
    """章节所处阶段（early/middle/late，value + 中文 label；列表顺序即展示顺序）。"""
    return [
        {"value": "early", "label": "前期"},
        {"value": "middle", "label": "中期"},
        {"value": "late", "label": "后期"},
    ]


DICT_BUILDERS: dict[str, object] = {
    "agents": _build_agents,
    "task_types": _build_task_types,
    "genre_aliases": _build_genre_aliases,
    "chapter_functions": _build_chapter_functions,
    "setting_types": _build_setting_types,
    "role_ranks": _build_role_ranks,
    "stages": _build_stages,
}


@router.get("")
def get_meta(keys: str = Query(default="", description="逗号分隔的字典 key；空 = 返回全部")) -> dict[str, object]:
    """按 key 返回枚举字典；未指定 key 时返回全部。前端带缓存按需取用。"""
    wanted = {k.strip() for k in keys.split(",") if k.strip()} if keys else set(DICT_BUILDERS)
    return {k: DICT_BUILDERS[k]() for k in wanted if k in DICT_BUILDERS}
