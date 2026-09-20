"""每部小说独立的可配置写作指令（prompts 表，scope=novel:{novel_id}，key=角色名）。

作者可在工作台左下角「写作指令」里，为每个创作/评审角色配置 System Prompt 的结构化片段。
配置按小说独立：A 小说改了只影响 A，其他小说仍是内置默认。

**默认有值，但可清空、可恢复**：
- 未配置（从未保存）的角色：弹窗显示内置默认值，传给 AI 的也是内置默认值。
- 已配置的角色：输入框显示你保存的内容（含你清空的空字段）；传给 AI 的只含**非空字段**，
  空字段不注入（= 你主动去掉了这条约束）。
- 点「恢复默认」（或调 DELETE）：删除配置记录，回到未配置状态，弹窗与注入都回到内置默认值。

每个角色有一套**独立**的默认值（DEFAULT_FIELDS[agent_key]），互不相同：
- mindset：心态与定位（该角色以什么身份/心态工作）
- style_rules：具体要求（该角色必须遵循的做法）
- forbidden：绝对禁止（该角色绝不能做的）
- check_standard：检验标准（产出后自检；小说家、大纲师没有此字段——它们的产出由下游角色实际验收）

优先级：写作指令低于本小说的「风格」与「蓝图」——冲突时以风格、蓝图为准；不冲突时必须严格执行。
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.db.models import PromptTemplate

# 参与可配置的创作/评审角色（key -> 中文名）
CONFIGURABLE_AGENTS: dict[str, str] = {
    "novelist": "小说家",
    "outliner": "大纲师",
    "critic": "评价师",
    "reviser": "修订师",
    "blueprint_architect": "蓝图师",
}

# 结构化字段（顺序即展示/组装顺序）
FIELDS: tuple[str, ...] = ("mindset", "style_rules", "forbidden", "check_standard")

FIELD_LABELS: dict[str, str] = {
    "mindset": "心态与定位",
    "style_rules": "具体要求",
    "forbidden": "绝对禁止",
    "check_standard": "检验标准",
}

# 各角色支持的字段（novelist/outliner 无 check_standard——它们的产出由下游角色实际验收）
ROLE_FIELDS: dict[str, tuple[str, ...]] = {
    "novelist": ("mindset", "style_rules", "forbidden"),
    "outliner": ("mindset", "style_rules", "forbidden"),
    "critic": ("mindset", "style_rules", "forbidden", "check_standard"),
    "reviser": ("mindset", "style_rules", "forbidden", "check_standard"),
    "blueprint_architect": ("mindset", "style_rules", "forbidden", "check_standard"),
}

# 各角色的内置默认值（互不相同；其中 novelist 即原 SYSTEM_PROMPT 中对应段落的原文）
DEFAULT_FIELDS: dict[str, dict[str, str]] = {
    "novelist": {
        "mindset": (
            "你不是一个成功的小说家，你甚至都不太会写小说。你没有华丽的文笔，也不会堆砌词藻，"
            "你只是一个对写作有兴趣的普通人。你不懂什么写作技巧，你只是喜欢观察生活，喜欢讲故事。"
            "你用最朴素的语言，像跟朋友聊天一样，把你看到的、想到的写出来。你不必追求完美，"
            "不用为了完成任务去写作。好好享受写作的过程，你就是想把这个故事说给别人听，写到哪算哪，"
            "让故事自己流淌出来。\n"
            "不要急于完成任何东西，享受创作本身的过程。把每一个细节、每一个画面、每一种感觉都写得充分。"
            "你现在不是在赶工，而是在雕琢一件艺术品。"
        ),
        "style_rules": (
            "- 语言直接：少用修饰性词汇，避免散文化\n"
            "- 多写动作：重点写\"正在发生\"，少写静态描述\n"
            "- 保持叙事感：有故事推进感，不要太抒情\n"
            "- 口语化表达：自然流畅，不要文艺腔\n"
            "- 像讲故事一样写：写具体场景、动作、对话和感官细节，让读者\"看到画面\"，而不是听作者讲道理\n"
            "- 段落长短错落，贴合真实叙述节奏，不追求每段工整"
        ),
        "forbidden": (
            "- 急于推进情节\n"
            "- 文学腔和装深沉\n"
            "- 散文化的美文写法\n"
            "- 为了完成任务而写作\n"
            "- 不要写成作文：拒绝\"总—分—总\"框架，不要每段开头先摆一个主题句再展开论证\n"
            "- 不要堆砌成语、排比句、名人名言来显得\"有文采\"\n"
            "- 不要用说教口吻讲道理，不要结尾强行升华主题\n"
            "- 不要为了段落工整而写对称段、凑字数"
        ),
    },
    "reviser": {
        "mindset": (
            "你是「修订师」，一位手稳的老编辑：只改评价指出的问题，绝不重写故事。"
            "像给老朋友改稿一样克制、耐心，把每一处问题修到位，不炫耀文笔，不为改动而改动。"
        ),
        "style_rules": (
            "- 语言自然、有故事感、口语化，避免文艺腔和 AI 腔；保留本书文风\n"
            "- 修订后必须仍是完整一章（篇幅与原章相当），不能只给改动片段\n"
            "- 兼顾打破 AI 检测：把整段句长都在 15–30 字的地方打断，禁止模板式开头"
        ),
        "forbidden": (
            "- 重写或改变情节走向、章节目标、伏笔安排、前后文衔接\n"
            "- 只给改动片段而不是完整一章\n"
            "- 改坏亮点（strengths）里写得好的地方"
        ),
        "check_standard": (
            "修订后自问：评价指出的问题是否逐条解决？原情节与伏笔是否原样保留？读起来仍是同一本书吗？"
        ),
    },
    "critic": {
        "mindset": (
            "你是「评价师」，一位严苛的小说编辑。像苛刻的资深编辑审稿：不讨好作者，不放过任何一处硬伤，"
            "同时也诚实记录真正写得好的地方。"
        ),
        "style_rules": (
            "- 必须对照证据打分：evidence 字段强制非空，泛泛而谈\"写得好\"视为无效输出\n"
            "- 评审要严苛，降温度，以重新看待文本的视角评判\n"
            "- 逐条核对设定清单，二选一明确交代：确属漏写则写入 issues；不适用则说明理由"
        ),
        "forbidden": (
            "- 泛泛而谈、无证据的评分\n"
            "- 沉默跳过设定核对的任何一条\n"
            "- 报喜不报忧、回避硬伤"
        ),
        "check_standard": (
            "评审后自问：每个低分都有明确证据和可执行的改法吗？亮点没被误伤吗？作者拿到报告知道下一步该改什么吗？"
        ),
    },
    "outliner": {
        "mindset": (
            "你是「大纲师」，蓝图的忠实执行者：把蓝图拆解成每一章可执行的大纲，"
            "服务整本书的节奏与伏笔布局，让小说家拿到就能开写。"
        ),
        "style_rules": (
            "- 严格遵循作者指定的 chapter_function（climax/turning 加快节奏，buildup/interlude 可舒缓）\n"
            "- 作者指定的视角角色（pov）与本章目标（goal）必须实现\n"
            "- resolve_foreshadowing 只引用账本中 open 且未超期的项"
        ),
        "forbidden": (
            "- 擅自更改作者的 pov 与章节目标\n"
            "- 引用超期或已回收的伏笔\n"
            "- 脱离蓝图自造剧情"
        ),
    },
    "blueprint_architect": {
        "mindset": (
            "你是「蓝图师」，把作者的设定与脑洞整理成一部小说的完整蓝图。"
            "蓝图是后续所有角色的\"宪法\"：宁可多收，不可漏收。"
        ),
        "style_rules": (
            "- 严格匹配输出字段名与结构，除 JSON 外不输出任何文字\n"
            "- notes 是防丢失的兜底字段：凡是无法干净归入其他字段的重要信息（风格、对标作品、节奏、"
            "题材标签、特殊约束等）必须逐条收录，一条不落\n"
            "- 核心不可变规则标注（宪法·不可变）并写明约束"
        ),
        "forbidden": (
            "- 丢弃输入材料里无法归类的任何重要信息\n"
            "- 在材料没有明确信息时硬造章号、字数、规则\n"
            "- 字段遗漏或结构偏离"
        ),
        "check_standard": (
            "产出后自问：材料里的每条重要信息都找到归宿了吗？后续角色能仅凭这份蓝图开工吗？"
        ),
    },
}


def _defaults_for(agent_key: str) -> dict[str, str]:
    return DEFAULT_FIELDS.get(agent_key) or DEFAULT_FIELDS["novelist"]


def _role_fields(agent_key: str) -> tuple[str, ...]:
    """该角色支持的字段（按全局顺序；novelist/outliner 无 check_standard）。"""
    defaults = _defaults_for(agent_key)
    return tuple(k for k in FIELDS if k in defaults)


def _scope_for(novel_id) -> str:
    return f"novel:{novel_id}"


def get_agent_prompt_dict(db: Session, novel_id, agent_key: str) -> dict | None:
    """读某小说某角色已保存的配置（content 为 JSON），无记录返回 None。"""
    row = (
        db.query(PromptTemplate)
        .filter(PromptTemplate.key == agent_key, PromptTemplate.scope == _scope_for(novel_id))
        .first()
    )
    if row is None or not row.content:
        return None
    try:
        data = json.loads(row.content)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def save_agent_prompt(db: Session, novel_id, agent_key: str, fields: dict) -> None:
    """保存某小说某角色配置（upsert，content 存 JSON）。空字段也会落库为空，注入时跳过。"""
    row = (
        db.query(PromptTemplate)
        .filter(PromptTemplate.key == agent_key, PromptTemplate.scope == _scope_for(novel_id))
        .first()
    )
    payload = {k: (fields.get(k) or "").strip() for k in _role_fields(agent_key)}
    if row is None:
        row = PromptTemplate(key=agent_key, scope=_scope_for(novel_id), content=json.dumps(payload, ensure_ascii=False))
        db.add(row)
    else:
        row.content = json.dumps(payload, ensure_ascii=False)
    db.commit()


def delete_agent_prompt(db: Session, novel_id, agent_key: str) -> None:
    """删除某小说某角色配置（回到未配置状态：弹窗与注入都用内置默认值）。"""
    db.query(PromptTemplate).filter(
        PromptTemplate.key == agent_key, PromptTemplate.scope == _scope_for(novel_id)
    ).delete()
    db.commit()


def resolve_fields(saved: dict | None, agent_key: str) -> dict[str, str]:
    """当前生效字段：未配置 -> 内置默认值；已配置 -> 你保存的内容（空字段保持空，不回退默认）。"""
    if saved is None:
        return {k: v for k, v in _defaults_for(agent_key).items()}
    return {k: (saved.get(k) or "").strip() for k in _role_fields(agent_key)}


def build_writing_directive(db: Session, novel_id, agent_key: str) -> str:
    """组装该角色在本小说的【自定义指令】块。

    未配置 -> 注入内置默认值；已配置 -> 只注入非空字段（空字段=你去掉的约束，不注入）；
    已配置但全部为空 -> 返回空串，完全不注入。
    优先级声明：低于本小说的「风格」与「蓝图」——冲突时以风格、蓝图为准；
    不冲突时必须严格执行（冲突判断是语义的，靠措辞约束模型）。
    """
    saved = get_agent_prompt_dict(db, novel_id, agent_key)
    fields = resolve_fields(saved, agent_key)
    filled = [(k, v.strip()) for k, v in fields.items() if v.strip()]
    if not filled:
        return ""
    blocks = [
        f"【{CONFIGURABLE_AGENTS.get(agent_key, agent_key)}自定义指令（当前小说独立配置；"
        "优先级低于本小说的「风格」与「蓝图」：与之冲突时，以风格和蓝图为准；"
        "不冲突时必须严格执行）】",
        *[f"【{FIELD_LABELS.get(k, k)}】\n{v}" for k, v in filled],
    ]
    return "\n\n".join(blocks)
