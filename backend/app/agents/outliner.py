"""大纲师（Outliner）：基于蓝图逐章产出章节大纲，并维护伏笔账本。"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import (
    Agent,
    ComponentBlock,
    ContextPack,
    PRIORITY_REQUIRED,
    PRIORITY_BASE,
    PRIORITY_MEMORY,
    PRIORITY_SETTING,
    PRIORITY_CONTEXT,
)
from app.agents.context import (
    derive_stage,
    filter_settings_for_chapter,
    format_blueprint_for_prompt,
    format_settings_for_prompt,
    get_active_blueprint,
    get_graph_relations_text,
    get_latest_memory,
    format_memory_prompt,
    get_novel,
    get_recent_story_states,
    get_settings_snapshot,
    get_story_states_matching_active,
    get_visible_open_ledger,
)
from app.agents.platform_rules import (
    PLATFORM_SIGNING_HEADER,
    PLATFORM_SIGNING_OUTLINE,
    get_background_generation_scope,
    format_genres_direction,
)
from app.schemas.agents import ChapterOutline

SYSTEM_PROMPT = """你是「大纲师」，基于小说蓝图逐章产出章节大纲。
输出必须是严格的 JSON（单章）：
{"chapter": {"no": 章号, "title": 标题, "goal": 本章目标, "chapter_function": "progression|buildup|turning|climax|revelation|resolution|interlude",
  "pov": 视角角色, "beats": [{"beat_no":1,"type":"scene","pov":"视角","content":"节拍内容","length_hint":"1200字","emotion":"情绪"}],
  "characters": [角色名 或 {"name":角色名,"position":定位,"note":作用}], "locations": [...],
  "conflicts": [{"type":"external|internal","with":"对象","stakes":"赌注"}],
  "plant_foreshadowing": [{"desc":"埋下的伏笔","payoff_hint":"回收提示","latest_payoff_chapter":20,"importance":"high|medium|low"}],
  "resolve_foreshadowing": [{"ledger_id":"伏笔账本ID","how":"如何回收"}],
  "thread_updates": [{"thread":"线索","new_state":"新状态"}]}}

铁律：
- chapter_function 决定节奏（climax/turning 加快节奏，buildup/interlude 可舒缓），作者指定时必须严格遵循，未指定时由你按剧情推进节奏判定并标注正确类型。
- 章号以指令为准：输出 JSON 中 chapter.no 必须等于指令要求的章号，不得因最近故事已写到其他章而更改目标章号（已写章节只作衔接参考）。
- 作者指定的视角角色（pov）与本章目标（goal）必须实现，不得擅自更改。
- resolve_foreshadowing 只能引用账本中 open 状态且未超期的项，ledger_id 必须使用下方伏笔账本列表里给出的真实 id，不得编造。
- plant_foreshadowing 的 importance 字段：默认 medium；**跨多章才回收、回收期远（>5 章）、或对主线走向起决定作用的伏笔必须标 high**（标 high 的伏笔会被「固化」——账本超过 20 条时也不会被挤出，是长篇早期伏笔不失忆的关键保障）；一次性小钩子标 low。
- characters 列出本章全部登场角色：已在设定库/前文出现过的角色只给名字即可；**本章新登场角色（如新同事、老板、客户等）必须写成对象并带定位说明**（position=身份定位，note=在剧情中的作用），供批准时沉淀为角色设定。
- 【角色-场景合理性】每个登场角色必须与其身份/关系/立场相符，只能出现在合理的场合：
  - 与某组织/地点没有关系边的角色（如非该公司员工），**不得凭空安排其出现在该组织场景**（公司办公室、员工活动等）；
  - 若该角色与前文已确立的信息源/人物关系不符（如与老板无交集却反复进出公司），应删除该出场或改由合理角色承担；
  - 已在设定库/前文确立的"非公司员工""与某人无往来"等边界设定必须严格遵守，不得擅自让角色越界登场。
"""

# 系统级固定段：平台签约标准（全系统最高优先级，任何写作指令/风格画像/蓝图/设定库都不得覆盖、削弱或删除）
SYSTEM_PROMPT = SYSTEM_PROMPT + "\n\n" + PLATFORM_SIGNING_HEADER + "\n\n" + PLATFORM_SIGNING_OUTLINE

# 章节功能 → 中文标签（与前端表单保持一致，用于把作者选择注入 prompt）
FUNC_LABELS = {
    "progression": "推进",
    "buildup": "铺垫",
    "turning": "转折",
    "climax": "高潮",
    "revelation": "揭秘",
    "resolution": "收束",
    "interlude": "间奏",
}


class OutlinerAgent(Agent[ChapterOutline]):
    task_type = "setting"
    temperature = 0.3
    mock_output = {
        "chapter": {
            "no": 3,
            "title": "灰烬来信",
            "goal": "揭示主角身份并触发与岚的第一次冲突",
            "chapter_function": "revelation",
            "pov": "岚",
            "beats": [
                {"beat_no": 1, "type": "scene", "pov": "岚", "content": "占卜房收到署名不明的信", "length_hint": "1200字", "emotion": "不安"}
            ],
            "characters": ["岚", "主角"],
            "locations": ["旧王城·占卜房"],
            "conflicts": [{"type": "external", "with": "主角", "stakes": "身份暴露"}],
            "plant_foreshadowing": [{"desc": "信的落款只有半枚印记", "payoff_hint": "与主角左手印记呼应", "latest_payoff_chapter": 20}],
            "resolve_foreshadowing": [],
            "thread_updates": [{"thread": "岚的伪装", "new_state": "被主角看穿破绽"}],
        }
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        try:
            chapter_no = int(params.get("chapter_no"))
        except (TypeError, ValueError):
            chapter_no = 0  # 未指定章号时跳过范围/阶段过滤

        # 重写模式：上下文以「本章」为中心双向注入——
        #   之前：最近几章既定情节（自然衔接起点，保证重写与开端一致）
        #   之后：本章之后已写章节（仅作约束：重写不得破坏后续既定走向/伏笔）
        # 新增模式：维持原样，注入最近几章故事状态（承接上一章续写）。
        if chapter_no > 0 and params.get("rewrite"):
            # 版本校验：只读「快照版本 == 该章当前激活版本」的快照，过期版本快照跳过（防时间泄漏）
            rows = get_story_states_matching_active(self.db, novel_id)
            before = [s for s in rows if s.chapter_no < chapter_no][-3:]
            after = [s for s in rows if s.chapter_no > chapter_no]
            parts = []
            if before:
                parts.append(
                    "【本章之前的既定情节（重写本章时必须与之自然衔接）】\n"
                    + "\n".join(f"#第{s.chapter_no}章摘要：{s.summary}" for s in before)
                )
            if after:
                parts.append(
                    "【本章之后已写的情节（重写本章时不得与之冲突：不提前揭晓、不提前登场、不改变已确立的走向）】\n"
                    + "\n".join(
                        f"#第{s.chapter_no}章摘要：{s.summary}"
                        + (f" | 下一步：{s.next_chapter_implications}" if s.next_chapter_implications else "")
                        for s in after
                    )
                )
            states_text = "\n\n".join(parts) or "（重写本章之前/之后都没有已写正文章节）"
        else:
            states = get_recent_story_states(self.db, novel_id)
            states_text = "\n".join(
                f"#第{s.chapter_no}章摘要：{s.summary}" + (f" | 下一步：{s.next_chapter_implications}" if s.next_chapter_implications else "")
                for s in states
            ) or "（还没有已写章节）"
        blueprint = get_active_blueprint(self.db, novel_id)
        stage = derive_stage(chapter_no, blueprint)
        relevant_settings = filter_settings_for_chapter(get_settings_snapshot(self.db, novel_id), chapter_no, stage)
        settings_text = format_settings_for_prompt(relevant_settings)

        # 注入待回收账本：按"超期优先 → 紧迫度高优先 → 引入早优先"排序，最多 20 条；
        # 超出部分不注入，仅提示数量，避免被 AI 遗忘（也防止上下文过长）。
        # 只注入「来源版本仍批准」的账本（大纲来源），未批准版本的行对大纲师不可见。
        ledger_rows = get_visible_open_ledger(self.db, novel_id)
        ledger_rows.sort(
            key=lambda r: (
                # 关键信息固化（C）：固化项永远排在前面（账本超 20 条也不被挤出）
                not r.is_pinned,
                0 if (chapter_no and r.target_reveal_chapter and r.target_reveal_chapter < chapter_no) else 1,
                -(r.urgency or 0),
                r.chapter_introduced or 0,
            )
        )
        top = ledger_rows[:20]
        ledger_text = "\n".join(
            f"- [{r.item_type}] {r.description}（id: {r.id}，引入第{r.chapter_introduced or '?'}章，紧迫度{r.urgency or '-'}）{'【已固化】' if r.is_pinned else ''}"
            for r in top
        ) or "（账本无 open 项）"
        if len(ledger_rows) > len(top):
            ledger_text += (
                f"\n…（其余 {len(ledger_rows) - len(top)} 条 open 项未列出，"
                "只按紧迫度展示了最要紧的；不要引用未列出的 id）"
            )

        # 实体关系图谱：已确立关系的一致性对照（设计冲突/新角色互动时不得与既有关系矛盾）
        relations_text = get_graph_relations_text(self.db, novel_id)

        # 作者要求：目标 / 章节节奏功能 / 视角角色（未指定则交由大纲师自行判定，并在产出里写清）
        goal = (params.get("goal") or "").strip()
        fn_raw = (params.get("chapter_function") or "").strip()
        fn_line = (
            f"本章节奏功能（作者指定，必须严格遵循）：{FUNC_LABELS.get(fn_raw, fn_raw)}"
            if fn_raw
            else "本章节奏功能：作者未指定，请根据蓝图分卷推进节奏与最近故事状态自行判定合适类型"
            "（progression 推进 / buildup 铺垫 / turning 转折 / climax 高潮 / revelation 揭秘 / resolution 收束 / interlude 间奏），并写进 chapter_function。"
        )
        pov = (params.get("pov") or "").strip()
        pov_line = (
            f"本章视角角色（作者指定，必须遵循）：{pov}"
            if pov
            else "本章视角角色：作者未指定，由你根据剧情需要选择合适的视角角色。"
        )
        goal_line = (
            f"本章目标（作者指定，必须实现）：{goal}"
            if goal
            else "本章目标：由你根据剧情自行把握。"
        )

        # 组件化上下文（token 预算器按优先级裁剪：硬约束不裁，超窗先裁设定/关系/状态）
        components = [
            ComponentBlock(
                "project",
                (
                    f"项目：《{novel.title if novel else novel_id}》\n"
                    f"世界背景类型：{(novel.background_type if novel else None) or 'realistic'}\n\n"
                    f"{get_background_generation_scope(novel.background_type if novel else None)}\n\n"
                    f"{format_genres_direction((novel.genres if novel else None) or [])}"
                ),
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "blueprint",
                f"蓝图（active 版）：\n{format_blueprint_for_prompt(blueprint)}",
                PRIORITY_BASE,
            ),
            ComponentBlock(
                "settings",
                f"相关设定（设定库，本章可直接调用的角色/地点/规则等）：\n{settings_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "memory",
                f"{format_memory_prompt(get_latest_memory(self.db, novel_id))}\n\n故事状态：\n{states_text}",
                PRIORITY_MEMORY,
            ),
            ComponentBlock(
                "ledger",
                f"伏笔账本 open 项：\n{ledger_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "relations",
                f"实体关系图谱（已确立关系，设计本章冲突/角色互动时不得与之矛盾）：\n{relations_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "titles",
                f"已写章节标题：{params.get('chapter_titles', [])}",
                PRIORITY_CONTEXT,
            ),
            ComponentBlock(
                "author_requirements",
                f"作者要求：\n{goal_line}\n{fn_line}\n{pov_line}",
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "instruction",
                f"请生成第 {params.get('chapter_no', '下一')} 章的大纲（这是对本章的生成/重写，输出 JSON 中 chapter.no 必须等于本指令章号，不得续写其他章）。",
                PRIORITY_REQUIRED,
            ),
        ]
        user_content = "\n\n".join(c.content for c in components)
        return ContextPack(
            novel_id=novel_id,
            agent="outliner",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            components=components,
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ChapterOutline:
        return ChapterOutline.model_validate_json(text.strip())
