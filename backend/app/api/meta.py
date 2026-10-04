"""元数据字典接口：角色名 / 任务类型 / 题材别名等枚举数据按 key 聚合下发。

前端统一经 GET /api/meta 拉取并做本地缓存（命中缓存不再请求，省开销），
避免每个枚举一个接口、前端多处维护副本导致漂移。
新增枚举字典 = 在 DICT_BUILDERS 注册一个构建函数 + key。

双层字典：内置枚举（代码 DICT_BUILDERS）只读；CUSTOMIZABLE_KEYS 里的 key
额外支持用户自定义项（存 meta_dict_items 表，GET 合并下发 / POST 新增 / DELETE 删除，
升级版本不重置）。题材即如此：作者自加题材直接正式入库。
"""
import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import MetaDictItem
from app.db.session import get_db

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


def _build_genre_presets() -> list[dict[str, str]]:
    """题材预置（value + 中文 label）：标准题材以 platform_rules.GENRE_DIRECTIONS 的 key 为权威源
    （每个题材有对应的写作方向指引，AI 也按这些题材族匹配）；用户自定义题材经 meta_dict_items 合并（CUSTOMIZABLE_KEYS）。"""
    from app.agents.platform_rules import GENRE_DIRECTIONS

    return [{"value": g, "label": g} for g in GENRE_DIRECTIONS]


def _build_background_types() -> list[dict[str, str]]:
    """世界背景类型（value + label + hint）：决定签约核查口径；
    value 集合与 schemas/novel.py 的 background_type 约束一致。"""
    return [
        {"value": "realistic", "label": "现实年代", "hint": "有真实世界对照，AI 会检查时代细节对不对（如 2000 年扩招、机构命名）"},
        {"value": "alternate", "label": "半架空", "hint": "大部分真实，加一些虚构设定"},
        {"value": "pure_fantasy", "label": "纯架空", "hint": "完全虚构的世界（玄幻/仙侠/奇幻），只要设定前后不矛盾就行"},
    ]


def _build_ledger_types() -> list[dict[str, str]]:
    """伏笔账本类型（value + 中文 label，与后端 PlotLedger.item_type 枚举一致）。"""
    return [
        {"value": "setup", "label": "埋设伏笔"},
        {"value": "thread", "label": "线索推进"},
        {"value": "character_state", "label": "角色状态"},
        {"value": "location_state", "label": "地点状态"},
        {"value": "unresolved_hook", "label": "未解钩子"},
    ]


def _build_beat_types() -> list[dict[str, str]]:
    """大纲节拍类型（value + 中文 label，后端大纲 content.beats[].type 的枚举）。"""
    return [
        {"value": "scene", "label": "场景"},
        {"value": "transition", "label": "过场"},
        {"value": "dialogue", "label": "对话"},
        {"value": "action", "label": "动作"},
        {"value": "reveal", "label": "揭示"},
    ]


def _build_rubric_labels() -> dict[str, str]:
    """评价维度中文标签（后端 QualityReview.rubric 各维度 key → 中文）。"""
    return {
        "blueprint_adherence": "蓝图贴合度",
        "consistency": "前后一致性",
        "character_voice": "角色口吻",
        "pacing": "节奏把控",
        "style_compliance": "文风与语言",
        "foreshadowing_accountability": "伏笔交代",
        "reader_retention": "读者追读",
    }


def _build_retention_hook_labels() -> dict[str, str]:
    """追读力子项中文标签（rubric.reader_retention 的子维度）。"""
    return {
        "opening_hook": "开篇钩子",
        "ending_hook": "章末悬念",
        "tension": "情绪张力",
        "anticipation": "期待感",
    }


def _build_severity_labels() -> dict[str, str]:
    """问题严重度中文标签（high/medium/low）。"""
    return {"high": "严重", "medium": "中等", "low": "轻微"}


def _build_source_labels() -> dict[str, str]:
    """章节版本来源中文标签（ChapterVersion.source）。"""
    return {
        "novelist": "初稿",
        "regenerate": "再稿",
        "reviser": "修订稿",
        "user_edit": "人工",
        "expanded": "AI 扩写",
        "merged": "手动合并",
    }


def _build_chapter_creation_modes() -> list[dict[str, str]]:
    """章节创建方式字典：人工输入与 AI 生成共用前端下拉选项。"""
    return [
        {"value": "ai", "label": "AI 生成"},
        {"value": "manual", "label": "人工输入"},
    ]


DICT_BUILDERS: dict[str, object] = {
    "agents": _build_agents,
    "task_types": _build_task_types,
    "genre_aliases": _build_genre_aliases,
    "chapter_functions": _build_chapter_functions,
    "setting_types": _build_setting_types,
    "role_ranks": _build_role_ranks,
    "stages": _build_stages,
    "genre_presets": _build_genre_presets,
    "background_types": _build_background_types,
    "ledger_types": _build_ledger_types,
    "beat_types": _build_beat_types,
    "rubric_labels": _build_rubric_labels,
    "retention_hook_labels": _build_retention_hook_labels,
    "severity_labels": _build_severity_labels,
    "source_labels": _build_source_labels,
    "chapter_creation_modes": _build_chapter_creation_modes,
}

# 支持「用户自定义项」的字典 key：内置枚举只读，自定义项存 meta_dict_items 表，
# GET 合并下发、POST 新增 / DELETE 删除（存库而非代码 → 升级版本不重置）。
CUSTOMIZABLE_KEYS = {"genre_presets"}


def _custom_item_value(item: object) -> str:
    """从字典条目里取 value：统一 {value:...}/{key:...} 两种形态，兜底字符串本身。"""
    if isinstance(item, dict):
        v = item.get("value") or item.get("key")
        return str(v) if v is not None else ""
    return str(item)


def _list_custom_items(dict_key: str, db: Session) -> list[dict[str, str]]:
    """用户自定义字典项（按创建时间正序；无则返回空列表）。带 custom 标记供前端区分可删除项。"""
    rows = (
        db.execute(
            select(MetaDictItem)
            .where(MetaDictItem.dict_key == dict_key)
            .order_by(MetaDictItem.created_at)
        )
        .scalars()
        .all()
    )
    return [{"value": r.value, "label": r.label, "custom": True} for r in rows]


def _upsert_custom_items(dict_key: str, values: list[str], db: Session) -> None:
    """把新增值批量登记为自定义字典项（已存在/与内置冲突的自动跳过，幂等）。"""
    if dict_key not in CUSTOMIZABLE_KEYS:
        return
    existing = {r.value for r in db.execute(select(MetaDictItem.value).where(MetaDictItem.dict_key == dict_key)).scalars()}
    built_values = {_custom_item_value(i) for i in DICT_BUILDERS[dict_key]()}
    added = False
    for v in dict.fromkeys(x.strip() for x in values if x and x.strip()):
        if v in existing or v in built_values:
            continue
        db.add(MetaDictItem(dict_key=dict_key, value=v, label=v))
        existing.add(v)
        added = True
    if added:
        db.commit()


def _merge_custom_items(dict_key: str, built: object, db: Session) -> object:
    """把用户自定义项合并进内置结果（内置在前、自定义追加在后；仅对 CUSTOMIZABLE_KEYS 生效）。"""
    if dict_key not in CUSTOMIZABLE_KEYS or not isinstance(built, list):
        return built
    custom = _list_custom_items(dict_key, db)
    if not custom:
        return built
    return [*built, *custom]


@router.get("")
def get_meta(
    keys: str = Query(default="", description="逗号分隔的字典 key；空 = 返回全部"),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """按 key 返回枚举字典（内置 + 用户自定义合并）；未指定 key 时返回全部。前端带缓存按需取用。"""
    wanted = {k.strip() for k in keys.split(",") if k.strip()} if keys else set(DICT_BUILDERS)
    return {k: _merge_custom_items(k, DICT_BUILDERS[k](), db) for k in wanted if k in DICT_BUILDERS}


class MetaItemIn(BaseModel):
    """新增自定义字典项入参。"""

    value: str = Field(..., min_length=1, max_length=32, description="自定义项 value（也作 label 兜底）")
    label: Optional[str] = Field(default=None, max_length=32, description="展示文案；缺省用 value")


@router.post("/{key}/items")
def add_meta_item(key: str, payload: MetaItemIn, db: Session = Depends(get_db)) -> dict[str, str]:
    """给指定字典新增一个用户自定义项（仅支持 CUSTOMIZABLE_KEYS 里的 key；内置枚举冲突/重复时 409）。"""
    if key not in CUSTOMIZABLE_KEYS:
        raise HTTPException(400, f"字典 {key} 不支持新增自定义项")
    value = re.sub(r"\s+", " ", payload.value).strip()
    if not value:
        raise HTTPException(422, "value 不能为空")
    label = (payload.label or "").strip() or value
    built_values = {_custom_item_value(i) for i in DICT_BUILDERS[key]()}
    if value in built_values:
        raise HTTPException(409, f"「{value}」已存在于内置枚举")
    exists = db.execute(
        select(MetaDictItem).where(MetaDictItem.dict_key == key, MetaDictItem.value == value)
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(409, f"「{value}」已存在")
    db.add(MetaDictItem(dict_key=key, value=value, label=label))
    db.commit()
    return {"value": value, "label": label}


@router.delete("/{key}/items/{value}")
def delete_meta_item(key: str, value: str, db: Session = Depends(get_db)) -> dict[str, bool]:
    """删除一个用户自定义字典项（仅限自定义项；内置枚举或不存在时 404/400）。"""
    if key not in CUSTOMIZABLE_KEYS:
        raise HTTPException(400, f"字典 {key} 不支持删除自定义项")
    item = db.execute(
        select(MetaDictItem).where(MetaDictItem.dict_key == key, MetaDictItem.value == value)
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(404, f"自定义项「{value}」不存在")
    db.delete(item)
    db.commit()
    return {"ok": True}
