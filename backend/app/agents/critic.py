"""评价师（Critic）：对照蓝图与账本评价章节质量，反哺小说家。"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import (
    filter_settings_for_chapter,
    format_blueprint_for_prompt,
    format_settings_for_prompt,
    derive_stage,
    get_active_blueprint,
    get_graph_relations_text,
    get_novel,
    get_recent_story_states,
    get_settings_snapshot,
    get_visible_open_ledger,
)
from app.schemas.agents import ReviewOutput
from app.services.setting_checker import check_chapter, format_for_prompt

SYSTEM_PROMPT = """你是「评价师」，一位严苛的小说编辑。对照蓝图/伏笔账本/设定评价章节质量。
输出必须是严格的 JSON：
{"overall_score": 0-100,
 "rubric": {
   "blueprint_adherence": {"score":0-100,"comment":"说明","evidence":"强制原文引用或账本条目引用，禁止为空"},
   "consistency": {"score":0-100,"comment":"","evidence":""},
   "character_voice": {"score":0-100,"comment":"","evidence":""},
   "pacing": {"score":0-100,"comment":"对照 chapter_function 的节奏","evidence":""},
   "style_compliance": {"score":0-100,"comment":"检验标准：读者会觉得这个作者挺有意思吗？语言自然流畅吗？有故事感而不是散文感吗？","evidence":""},
   "foreshadowing_accountability": {"score":0-100,"comment":"","evidence":""}},
 "issues": [{"severity":"high|medium|low","type":"consistency|pacing|character_voice|style|foreshadowing","desc":"问题","suggested_fix":"改法"}],
 "strengths": [...], "revision_hints": [...]}

铁律：
- 必须对照证据打分：evidence 字段强制非空，泛泛而谈"写得好"视为无效输出。
- 评审要严苛，降温度，视角重新看待文本。
- 【设定核对清单】是**程序预先算出来的字面核对结果**，不是猜测。
  对其中每一条，你必须二选一并明确交代：
  (a) 确属漏写 → 写入 issues，severity 至少 medium，type 填 "setting_check"，
      desc 里说明"本章出现了 X 却没有 Y，违反《规则名》要求一组同时出现"；
  (b) 本章不适用（例如本章根本没有出现该设定所指的对象）→ 在对应 rubric 的 comment 里
      用一句话说明为什么不适用，**不允许沉默跳过**。
"""


class CriticAgent(Agent[ReviewOutput]):
    task_type = "review"
    temperature = 0.3
    mock_output = {
        "overall_score": 78,
        "rubric": {
            "blueprint_adherence": {
                "score": 80,
                "comment": "主冲突推进符合蓝图第三卷走向",
                "evidence": "原文引用：'他握紧了那份契约'，对应伏笔账本条目#3",
            },
            "consistency": {
                "score": 75,
                "comment": "与上一章故事状态一致，无矛盾",
                "evidence": "原文引用：'晨雾散去'，衔接上一章结尾的雨天",
            },
            "character_voice": {
                "score": 70,
                "comment": "主角口吻基本稳定，略有说教感",
                "evidence": "原文引用：'你不懂，这不一样'",
            },
            "pacing": {
                "score": 85,
                "comment": "符合 chapter_function=buildup 的渐进节奏",
                "evidence": "原文引用：'脚步声由远及近，越来越快'",
            },
            "style_compliance": {
                "score": 76,
                "comment": "语言自然，个别句子偏书面",
                "evidence": "原文引用：'他望向远方'",
            },
            "foreshadowing_accountability": {
                "score": 72,
                "comment": "成功回收一条伏笔，新埋一条",
                "evidence": "原文引用：'那枚铜币滚落在地'，对应账本条目的 payoff",
            },
        },
        "issues": [
            {
                "severity": "low",
                "type": "pacing",
                "desc": "第二章中段节奏稍缓",
                "suggested_fix": "压缩环境描写段落",
            }
        ],
        "strengths": ["对话推进冲突自然", "伏笔回收清晰"],
        "revision_hints": ["减少'他望向远方'类空镜", "加强配角存在感"],
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        states = get_recent_story_states(self.db, novel_id)
        states_text = "\n".join(f"#第{s.chapter_no}章：{s.summary}" for s in states) or "（无）"

        # 伏笔账本 open 项（M2：foreshadowing_accountability 对照依据；只注入来源版本仍批准的）
        ledger_rows = get_visible_open_ledger(self.db, novel_id)
        ledger_text = "\n".join(
            f"- [#{str(r.id)[:8]}][{r.item_type}] {r.description}（第{r.chapter_introduced or '?'}章埋，"
            f"紧迫度{r.urgency or '-'}，目标揭示章{r.target_reveal_chapter or '-'}）"
            for r in ledger_rows[:20]
        ) or "（账本无 open 项）"

        # 实体关系图谱：评价 consistency 时对照，防止章节写崩已确立关系
        relations_text = get_graph_relations_text(self.db, novel_id)

        # 设定库（此前评价师完全看不到，导致设定被漏写也评不出来；
        # 小说家一直能看到，这里补齐同一份视野。与 novelist 一样按章节阶段过滤）
        chapter_no = params.get("chapter_no")
        blueprint = get_active_blueprint(self.db, novel_id)
        stage = derive_stage(chapter_no, blueprint) if chapter_no is not None else None
        active_settings = filter_settings_for_chapter(
            get_settings_snapshot(self.db, novel_id), chapter_no or 0, stage
        )
        settings_text = format_settings_for_prompt(active_settings)

        # 确定性设定核对：不靠 LLM 印象，用字面匹配算"必现清单是否被写漏"
        check_items = check_chapter(
            self.db, novel_id, params.get("chapter_text", "") or "", blueprint, active_settings
        )
        check_text = format_for_prompt(check_items)

        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n"
            f"蓝图（active，评价 blueprint_adherence 时对照）：\n"
            f"{format_blueprint_for_prompt(blueprint)}\n\n"
            f"本章大纲（含 chapter_function）：{params.get('outline', '（无）')}\n"
            f"最近故事状态：\n{states_text}\n\n"
            f"伏笔账本 open 项（评价 foreshadowing_accountability 与一致性时对照）：\n{ledger_text}\n\n"
            f"实体关系图谱（评价 consistency 时对照，正文不得与已确立关系矛盾）：\n{relations_text}\n\n"
            f"设定库（共 {len(active_settings)} 条，评价设定是否被落实/写歪的对照依据）：\n{settings_text}\n\n"
            f"【设定核对清单·程序确定性核对结果，逐条必须回应】\n{check_text}\n\n"
            f"待评价章节正文：\n{params.get('chapter_text', '')}\n\n"
            f"该章节的写作模式：{params.get('writing_mode', 'draft_free')}"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="critic",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params, "setting_check": check_items},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ReviewOutput:
        return ReviewOutput.model_validate_json(text.strip())
