"""评价师（Critic）：对照蓝图与账本评价章节质量，反哺小说家。"""
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
    filter_settings_for_chapter,
    format_blueprint_for_prompt,
    format_settings_for_prompt,
    derive_stage,
    get_active_blueprint,
    get_graph_relations_text,
    get_latest_memory,
    format_memory_prompt,
    get_novel,
    get_recent_chapters,
    get_recent_story_states,
    get_settings_snapshot,
    get_visible_open_ledger,
)
from app.agents.platform_rules import (
    BACKGROUND_TYPE_SCOPE,
    PLATFORM_SIGNING_HEADER,
    PLATFORM_SIGNING_REVIEW,
    format_genres_direction,
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
- 【冲突红线】评价与每条建议必须对照【最近章节全文】【实体关系图谱】【设定库】【伏笔账本 open 项】核查：
  建议若会与上文已确立的事实/关系/设定矛盾、或会动到未回收的伏笔 → **不得提出该建议**；
  正文与上文确有矛盾时，写成 issues 指出"本章与上文冲突（依据）"，而不是建议修改上文。
- 【角色-场景合理性】对本章出场的每个角色逐一核查"为什么此刻在此地、他如何知道当前信息、与在场者是什么关系"：
  出现以下任一情况 → 必须写入 issues（severity 至少 medium，type 填 "consistency"，desc 指明角色与问题）：
  (a) 角色凭空出现在与其身份/关系不符的场合（如与老板无工作交集的人反复进出公司，找不到合理的在场理由）；
  (b) 角色掌握了与其处境不符的信息（信息来源悬空，读者无法推断）；
  (c) 角色出场对情节无推动作用，仅是为"说教/提醒"而生硬登场，显得刻意。
  这类问题宁可指出"建议删除该场景或改为合理角色承担"，也不要放过或只提示措辞。
- 【设定核对清单】是**程序预先算出来的字面核对结果**，不是猜测。
  对其中每一条，你必须二选一并明确交代：
  (a) 确属漏写 → 写入 issues，severity 至少 medium，type 填 "setting_check"，
      desc 里说明"本章出现了 X 却没有 Y，违反《规则名》要求一组同时出现"；
  (b) 本章不适用（例如本章根本没有出现该设定所指的对象）→ 在对应 rubric 的 comment 里
      用一句话说明为什么不适用，**不允许沉默跳过**。
"""

# 系统级固定段：平台签约标准（全系统最高优先级，任何写作指令/风格画像/蓝图/设定库都不得覆盖、削弱或删除）
SYSTEM_PROMPT = SYSTEM_PROMPT + "\n\n" + PLATFORM_SIGNING_HEADER + "\n\n" + PLATFORM_SIGNING_REVIEW


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
        # 世界背景类型决定签约核查口径：现实年代对照真实世界、纯架空只查设定账本自洽
        background_scope = BACKGROUND_TYPE_SCOPE.get(
            (novel.background_type if novel else None) or "realistic",
            BACKGROUND_TYPE_SCOPE["realistic"],
        )
        states = get_recent_story_states(self.db, novel_id)
        states_text = "\n".join(f"#第{s.chapter_no}章：{s.summary}" for s in states) or "（无）"

        # 最近章节全文：评价一致性时对照上文，防止建议/判罚与已写章节冲突（排除本章自己）
        chapters = get_recent_chapters(self.db, novel_id)
        prev_text = "\n\n".join(
            f"[第{c.chapter_no}章 {c.title or ''}]\n{c.content}"
            for c in reversed(chapters)
            if c.chapter_no != params.get("chapter_no")
        ) or "（无前文）"

        # 伏笔账本 open 项（M2：foreshadowing_accountability 对照依据；只注入来源版本仍批准的）
        ledger_rows = get_visible_open_ledger(self.db, novel_id)
        # 关键信息固化（C）：固化项永远排在前面（账本超 20 条也不被挤出）
        ledger_rows.sort(key=lambda r: (not r.is_pinned, -(r.urgency or 0), r.chapter_introduced or 0))
        ledger_text = "\n".join(
            f"- [#{str(r.id)[:8]}][{r.item_type}] {r.description}（第{r.chapter_introduced or '?'}章埋，"
            f"紧迫度{r.urgency or '-'}，目标揭示章{r.target_reveal_chapter or '-'}）{'【已固化】' if r.is_pinned else ''}"
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

        # 组件化上下文（token 预算器按优先级裁剪：硬约束不裁，超窗先裁前文/关系/设定）
        components = [
            ComponentBlock(
                "project",
                f"项目：《{novel.title if novel else novel_id}》\n"
                f"{format_genres_direction((novel.genres if novel else None) or [])}",
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "blueprint",
                f"蓝图（active，评价 blueprint_adherence 时对照）：\n{format_blueprint_for_prompt(blueprint)}",
                PRIORITY_BASE,
            ),
            ComponentBlock(
                "outline",
                f"本章大纲（含 chapter_function）：{params.get('outline', '（无）')}",
                PRIORITY_BASE,
            ),
            ComponentBlock(
                "memory",
                f"{format_memory_prompt(get_latest_memory(self.db, novel_id))}\n\n最近故事状态：\n{states_text}",
                PRIORITY_MEMORY,
            ),
            ComponentBlock(
                "prev_text",
                f"最近章节全文（评价一致性时对照上文，建议不得与上文已确立事实/关系/设定矛盾）：\n{prev_text}",
                PRIORITY_CONTEXT,
            ),
            ComponentBlock(
                "ledger",
                f"伏笔账本 open 项（评价 foreshadowing_accountability 与一致性时对照）：\n{ledger_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "relations",
                f"实体关系图谱（评价 consistency 时对照，正文不得与已确立关系矛盾）：\n{relations_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "settings",
                f"设定库（共 {len(active_settings)} 条，评价设定是否被落实/写歪的对照依据）：\n{settings_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "setting_check",
                f"【设定核对清单·程序确定性核对结果，逐条必须回应】\n{check_text}",
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "background_scope",
                background_scope,
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "chapter_text",
                f"待评价章节正文：\n{params.get('chapter_text', '')}",
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "writing_mode",
                f"该章节的写作模式：{params.get('writing_mode', 'draft_free')}",
                PRIORITY_BASE,
            ),
        ]
        user_content = "\n\n".join(c.content for c in components)
        return ContextPack(
            novel_id=novel_id,
            agent="critic",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            components=components,
            meta={"params": params, "setting_check": check_items},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> ReviewOutput:
        return ReviewOutput.model_validate_json(text.strip())
