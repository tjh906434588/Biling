"""编年师（Memory Keeper）：把历史记忆压缩成「作品编年总览」，解决长篇早期记忆丢失。

每 N 章自动触发一次（N 见配置 chronicle_generate_every，默认 10）。输入 = 全部故事快照
摘要/关键事件 + 伏笔账本 open 项 + 蓝图 + 已确立关系，输出 = 固定大小的结构化编年，
长期注入 novelist/outliner/critic/reviser——窗口外的早期主线/伏笔/设定不会因窗口滑动而失忆。
"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import (
    get_active_blueprint,
    format_blueprint_for_prompt,
    get_graph_relations_text,
    get_novel,
    get_story_states_matching_active,
    get_visible_open_ledger,
)
from app.schemas.agents import ChronicleOutput

SYSTEM_PROMPT = """你是「编年师」，把一本小说的全部历史记忆压缩成一份「作品编年总览」。
输入是按章节排列的故事快照（摘要+关键事件）、伏笔账本、蓝图、实体关系图谱。
输出必须是严格的 JSON：
{"main_line":"主线一句话：故事当前讲到哪",
 "volumes_progress":[{"name":"线名","status":"推进中|已完结|搁置","progress":"已写到哪、下一关键节点"}],
 "character_goals":[{"character":"角色","goal":"当前目标","progress":"推进到哪一步"}],
 "active_foreshadowing":[{"desc":"伏笔内容","since_chapter":1,"hint":"回收提示"}],
 "established_world":["已确立的重大设定/世界状态"],
 "open_threads":["未解线索/遗留钩子"],
 "next_direction":"后续自然走向"}

铁律：
- 这是给写作/评价 agent 的长期记忆，不是摘要复述：只保留【窗口外仍必须记住】的信息——
  主线走向、各卷/各线进度、角色未完成的目标、尚未回收的伏笔（尤其早期埋设的）、
  已确立且长期有效的大设定、未解线索、下一阶段方向。
- main_line 一句话概括当前主线进展（含大概写到第几章）。
- active_foreshadowing 只收录「尚未回收」的重要伏笔，跨早期章节，不要只列最近几章。
- established_world 收录跨章节长期成立的世界规则/重大事实，避免后续章节自己推翻。
- 每条字段精炼；总览整体控制在 800 字以内，防止挤占生成上下文。
"""


class MemoryKeeperAgent(Agent[ChronicleOutput]):
    task_type = "creation"
    temperature = 0.3
    mock_output = {
        "main_line": "主角在第 10 章追查身世真相，正前往旧档案馆（编年师 Mock）。",
        "volumes_progress": [{"name": "主线", "status": "推进中", "progress": "身世线索：档案馆"}, {"name": "权谋线", "status": "搁置", "progress": "尚未展开"}],
        "character_goals": [{"character": "主角", "goal": "查明身世", "progress": "已发现记忆伪造，去档案馆"}],
        "active_foreshadowing": [{"desc": "主角左手印记发光", "since_chapter": 1, "hint": "指向血脉真相"}],
        "established_world": ["本世界存在旧档案馆，保存出生记录"],
        "open_threads": ["岚的真实身份"],
        "next_direction": "主角潜入旧档案馆查找记录",
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        # 全部故事快照（按章升序）：每章只取摘要 + high 关键事件，压缩输入体积
        states = get_story_states_matching_active(self.db, novel_id)
        if states:
            chunks = []
            for s in states:
                evs = []
                for e in (s.key_events or []):
                    if isinstance(e, dict) and e.get("importance") in ("high", "medium"):
                        evs.append(e.get("event", ""))
                line = f"[{s.chapter_no}章] {s.summary}"
                if evs:
                    line += "｜关键：" + "；".join(evs[:5])
                chunks.append(line)
            states_text = "\n".join(chunks)
        else:
            states_text = "（暂无故事快照）"
        # 伏笔账本 open 项（全部，编年需要覆盖早期伏笔；固化项优先列出）
        ledger_rows = get_visible_open_ledger(self.db, novel_id)
        ledger_rows.sort(key=lambda r: (not r.is_pinned, r.chapter_introduced or 0))
        ledger_text = "\n".join(
            f"- [{r.item_type}][{r.chapter_introduced or '?'}章] {r.description}{'【已固化】' if r.is_pinned else ''}"
            for r in ledger_rows
        ) or "（无 open 项）"
        # 蓝图 + 已确立关系（长期设定来源）
        blueprint_text = format_blueprint_for_prompt(get_active_blueprint(self.db, novel_id))
        relations_text = get_graph_relations_text(self.db, novel_id)
        up_to = params.get("up_to_chapter")
        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n"
            f"编年覆盖：第 {up_to or '最新'} 章\n\n"
            f"故事快照（按章升序，每章=摘要+关键事件）：\n{states_text}\n\n"
            f"伏笔账本 open 项（按引入章升序，覆盖早期伏笔）：\n{ledger_text}\n\n"
            f"蓝图（各卷/各线设计参照）：\n{blueprint_text}\n\n"
            f"已确立实体关系（长期设定参照）：\n{relations_text}\n\n"
            "请生成作品编年总览 JSON。"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="memory_keeper",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ChronicleOutput:
        return ChronicleOutput.model_validate_json(text.strip())
