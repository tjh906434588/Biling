"""提取师（Extractor）：把成稿章节压缩为结构化记忆，驱动长篇一致性。"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_graph_relations_text, get_novel, get_settings_snapshot
from app.db.models import PlotLedger
from app.schemas.agents import StoryStateExtract

SYSTEM_PROMPT = """你是「提取师」，把成稿章节压缩为结构化记忆。
输出必须是严格的 JSON：
{"summary": "120字摘要",
 "key_events": [{"event":"事件","importance":"high|medium|low"}],
 "character_states": [{"character":"角色","state":"当前状态","confidence":"high|medium|low"}],
 "world_state_changes": [{"rule":"世界规则","change":"变化"}],
 "new_foreshadowing": [{"desc":"新伏笔","hint":"回收提示","suggested_payoff_chapter":null}],
 "resolved_foreshadowing": [{"ledger_id":"账本ID"}],
 "unresolved_hooks": [{"hook":"未解钩子","since_chapter":1}],
 "relations": [{"source":"实体A","relation":"关系标签","target":"实体B","confidence":"high|medium|low"}],
 "superseded_relations": [{"source":"实体A","relation":"旧关系","target":"实体B","superseded_by":"取代它的新关系名"}],
 "next_chapter_implications": ["下一章的自然走向"]}

铁律：
- 压缩不是缩写，是"结构化记忆"；character_states 标注置信度，low 的进待确认队列。
- resolved_foreshadowing 里的 ledger_id 必须是已有账本条目。
- relations：只抽取本章【明确出现或确立】的实体关系（人物/组织/地点/物品之间，如"拜师/敌对/加入/忌惮/持有"），不要猜测旧关系，不要写空泛修饰；实体名优先沿用【已有实体名单】；每章 relations 最多 8 条，无则空数组 []，superseded_relations 无则空数组 []。
- 关系先判定是【共存】还是【递进】，再落两处字段：
  ① 【共存/新情节】：本章结束后旧关系【仍然成立】→ 新关系并列进 relations，旧关系【不得】进 superseded_relations。例：A、B 一直是同事，本章 A 质疑 B → relations=[同事, 质疑]，superseded_relations=[]（同事仍成立，只是新增质疑，两者同时有效）。
  ② 【递进/取代】：旧关系本章结束后【不再成立】，一律由新关系替代，只输出新关系到 relations，旧关系进 superseded_relations（source/relation/target 必须与【当前已确立的实体关系】列表逐字一致），superseded_by 指名取代它的新关系名（须是本章 relations 中同 source/target 的关系）。正文明确旧关系结束但没给新名词时，用「不+旧关系名」作新关系（不再质疑 → 不质疑），统一按递进处理。例：本章 A 不再质疑 B → relations=[同事, 不质疑]，superseded_relations=[{"source":"A","relation":"质疑","target":"B","superseded_by":"不质疑"}]（质疑递进为不质疑，同事保持）；本章 A、B 和好为朋友 → relations=[同事, 朋友]，superseded_relations=[{"source":"A","relation":"质疑","target":"B","superseded_by":"朋友"}]。
- 判定铁律：正文没有明确表示旧关系结束的，一律按【共存】处理（保留旧关系、不标取代），不要推测；只有正文明确推翻旧关系（"不再/解开/和解/叛出"等）才算递进。
"""


class ExtractorAgent(Agent[StoryStateExtract]):
    task_type = "extract"
    temperature = 0.15
    mock_output = {
        "summary": "主角发现自己的记忆可能是伪造的，决定前往旧档案馆查证出生记录。",
        "key_events": [{"event": "主角左手印记再次发光", "importance": "high"}, {"event": "主角决定调查身世", "importance": "high"}],
        "character_states": [{"character": "主角", "state": "开始怀疑记忆真实性", "confidence": "high"}],
        "world_state_changes": [],
        "new_foreshadowing": [{"desc": "旧档案馆里有一份本不该存在的出生记录", "hint": "指向主角身世真相", "suggested_payoff_chapter": None}],
        "resolved_foreshadowing": [],
        "unresolved_hooks": [{"hook": "岚的真实身份", "since_chapter": 1}],
        "relations": [{"source": "主角", "relation": "追查", "target": "旧档案馆", "confidence": "high"}],
        "superseded_relations": [],
        "next_chapter_implications": ["主角将潜入旧档案馆"],
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        chapter_text = params.get("chapter_text", "")
        chapter_no = params.get("chapter_no", "?")
        # 已有实体名单：帮助关系抽取时实体名对齐，减少同名分身
        known = get_settings_snapshot(self.db, novel_id, limit=100)
        known_text = "、".join(s.name for s in known) or "（无）"
        # 待回收伏笔账本：resolved_foreshadowing 只能引用其中的真实 id，不得编造。
        # 按"紧迫度高优先 → 引入早优先"排序，最多 20 条，超出部分仅提示数量。
        ledger_rows = self.db.query(PlotLedger).filter(
            PlotLedger.novel_id == novel_id, PlotLedger.status == "open"
        ).all()
        ledger_rows.sort(key=lambda r: (-(r.urgency or 0), r.chapter_introduced or 0))
        top = ledger_rows[:20]
        ledger_text = "\n".join(
            f"- [{r.item_type}] {r.description}（id: {r.id}）"
            for r in top
        ) or "（无 open 项，resolved_foreshadowing 输出空数组 []）"
        if len(ledger_rows) > len(top):
            ledger_text += f"\n…（其余 {len(ledger_rows) - len(top)} 条 open 项未列出）"
        # 当前已确立的实体关系快照：供取代识别（superseded_relations 只能引用这里的旧关系）
        relations_text = get_graph_relations_text(self.db, novel_id)
        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n"
            f"待提取章节：第 {chapter_no} 章\n\n"
            f"已有实体名单（relations 里实体名尽量沿用）：{known_text}\n\n"
            f"当前已确立的实体关系（superseded_relations 必须引用这里的旧关系）：\n{relations_text}\n\n"
            f"待回收伏笔账本（resolved_foreshadowing 的 ledger_id 只能从下面列表取真实 id）：\n{ledger_text}\n\n"
            f"章节正文：\n{chapter_text}\n\n"
            f"上一章故事状态：{params.get('prev_state', '（无）')}"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="extractor",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> StoryStateExtract:
        return StoryStateExtract.model_validate_json(text.strip())
