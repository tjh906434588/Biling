"""大纲师（Outliner）：基于蓝图逐章产出章节大纲，并维护伏笔账本。"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import (
    derive_stage,
    filter_settings_for_chapter,
    format_blueprint_for_prompt,
    format_settings_for_prompt,
    get_active_blueprint,
    get_novel,
    get_recent_story_states,
    get_settings_snapshot,
)
from app.db.models import PlotLedger
from app.schemas.agents import ChapterOutline

SYSTEM_PROMPT = """你是「大纲师」，基于小说蓝图逐章产出章节大纲。
输出必须是严格的 JSON（单章）：
{"chapter": {"no": 章号, "title": 标题, "goal": 本章目标, "chapter_function": "progression|buildup|turning|climax|revelation|resolution|interlude",
  "pov": 视角角色, "beats": [{"beat_no":1,"type":"scene","pov":"视角","content":"节拍内容","length_hint":"1200字","emotion":"情绪"}],
  "characters": [...], "locations": [...],
  "conflicts": [{"type":"external|internal","with":"对象","stakes":"赌注"}],
  "plant_foreshadowing": [{"desc":"埋下的伏笔","payoff_hint":"回收提示","latest_payoff_chapter":20}],
  "resolve_foreshadowing": [{"ledger_id":"伏笔账本ID","how":"如何回收"}],
  "thread_updates": [{"thread":"线索","new_state":"新状态"}]}}

铁律：
- chapter_function 决定节奏（climax/turning 加快节奏，buildup/interlude 可舒缓），作者指定时必须严格遵循，未指定时由你按剧情推进节奏判定并标注正确类型。
- 作者指定的视角角色（pov）与本章目标（goal）必须实现，不得擅自更改。
- resolve_foreshadowing 只能引用账本中 open 状态且未超期的项，ledger_id 必须使用下方伏笔账本列表里给出的真实 id，不得编造。
"""

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
        states = get_recent_story_states(self.db, novel_id)
        states_text = "\n".join(
            f"#第{s.chapter_no}章摘要：{s.summary}" + (f" | 下一步：{s.next_chapter_implications}" if s.next_chapter_implications else "")
            for s in states
        ) or "（还没有已写章节）"

        # 注入本章相关的设定库明细：按章节范围/阶段过滤（与蓝图整合互补，强化对设定的遵循）
        try:
            chapter_no = int(params.get("chapter_no"))
        except (TypeError, ValueError):
            chapter_no = 0  # 未指定章号时跳过范围/阶段过滤
        blueprint = get_active_blueprint(self.db, novel_id)
        stage = derive_stage(chapter_no, blueprint)
        relevant_settings = filter_settings_for_chapter(get_settings_snapshot(self.db, novel_id), chapter_no, stage)
        settings_text = format_settings_for_prompt(relevant_settings)

        # 注入待回收账本：按"超期优先 → 紧迫度高优先 → 引入早优先"排序，最多 20 条；
        # 超出部分不注入，仅提示数量，避免被 AI 遗忘（也防止上下文过长）。
        ledger_rows = self.db.query(PlotLedger).filter(
            PlotLedger.novel_id == novel_id, PlotLedger.status == "open"
        ).all()
        ledger_rows.sort(
            key=lambda r: (
                0 if (chapter_no and r.target_reveal_chapter and r.target_reveal_chapter < chapter_no) else 1,
                -(r.urgency or 0),
                r.chapter_introduced or 0,
            )
        )
        top = ledger_rows[:20]
        ledger_text = "\n".join(
            f"- [{r.item_type}] {r.description}（id: {r.id}，引入第{r.chapter_introduced or '?'}章，紧迫度{r.urgency or '-'}）"
            for r in top
        ) or "（账本无 open 项）"
        if len(ledger_rows) > len(top):
            ledger_text += (
                f"\n…（其余 {len(ledger_rows) - len(top)} 条 open 项未列出，"
                "只按紧迫度展示了最要紧的；不要引用未列出的 id）"
            )

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

        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n"
            f"蓝图（active 版）：\n{format_blueprint_for_prompt(blueprint)}\n\n"
            f"相关设定（设定库，本章可直接调用的角色/地点/规则等）：\n{settings_text}\n\n"
            f"最近故事状态：\n{states_text}\n\n"
            f"伏笔账本 open 项：\n{ledger_text}\n\n"
            f"已写章节标题：{params.get('chapter_titles', [])}\n\n"
            f"作者要求：\n{goal_line}\n{fn_line}\n{pov_line}\n\n"
            f"请生成第 {params.get('chapter_no', '下一')} 章的大纲。"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="outliner",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ChapterOutline:
        return ChapterOutline.model_validate_json(text.strip())
