"""修订师（Reviser）：按评价师报告逐条优化章节正文，生成修订版（直接定稿为新版本）。

与小说家的区别：不重新创作情节，而是基于"当前章节正文 + 评价问题"做修订——
保留原情节走向、章节目标、伏笔安排与前文衔接，只修正评价指出的问题。
"""
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
    PRIORITY_STYLE,
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
    get_latest_style_profile,
    get_novel,
    get_recent_chapters,
    get_recent_story_states,
    get_settings_snapshot,
)
from app.agents.l1 import L1_ANTI_AI_CONSTRAINTS
from app.schemas.agents import NovelChapter
from app.services.detector import detect
from app.services.entity_checker import format_hard_facts_snapshot

SYSTEM_PROMPT = f"""你是「修订师」，一位手稳的老编辑。你的任务是：**只改评价指出的问题，绝不重写故事**。

- 输入会给你：本章当前正文 + 评价师报告（六维评分、问题清单与改法、亮点、修改建议）。
- 输出必须是严格的 JSON：{{"title": "本章原标题（必须与修订前一字不差，禁止改名）", "content": "修订后的完整章节正文", "note": "本次修订说明：针对哪些问题改了什么"}}

修订铁律：
0. 【作者否决·绝对优先】若 prompt 中出现【最高指令·作者否决】，其中列出的问题作者已明确否决：
   - **禁止按其 suggested_fix 或任何方式修改对应内容，相关原文保持一字不动**；
   - 只处理未被否决的其他问题；
   - 修订 note 中必须逐条交代"第 N 条已按作者意见保留原文"，不得遗漏。
0'. 【作者批注·修改要求】若 prompt 中出现【作者批注·修改要求】，那是作者**本人发现的问题/修改要求**（可能不在评价师清单里）：
   - 与【作者否决】相反，批注的默认语义是**要改**：批注属实（确与上文已确立的事实/设定/关系/时间线冲突）→ 按批注意图修改正文；
   - 若判断批注不成立、或按批注改会破坏更重要的上文设定 → 不改，但必须在 note 中写明"未按作者批注修改：<原因>"，不得静默忽略。
   - 【结构性修改授权】若批注明确质疑某个角色出场/某个场景本身不合理（如"他为什么来""没交集""逻辑不通""太刻意""不合理"等），
     说明作者要的是**这个场景成立与否**，而非来意修补。此时授权做结构性处理，不受铁律 2"只做局部手术"限制：
     优先直接删除该场景；若该信息对本章情节必不可少，则改为由在场/合理角色传递，或换成更自然的信息传递方式（偶遇、电话、主动询问等）；
     处理后在 note 中明确交代"已删除/已改写 <原场景>，原因：作者批注指出 <问题>"。绝不允许继续用"补一个更圆的理由"来保留原场景。
1. 【冲突红线】逐条对照评价的 issues / revision_hints 时，先对照【最近章节全文】【实体关系图谱】【相关设定】核查该建议是否与上文已确立的事实/关系/设定/未回收伏笔矛盾：
   - 建议本身会破坏上文 → **一律不采纳**，不改动对应内容，并在 note 中写明"未采纳：<该建议>，原因：与上文冲突（<依据>）"。
   - 不要为了迎合评价而改坏上文已确立的设定、人物关系、伏笔与情节走向。
2. 情节走向、章节目标、伏笔安排、与前后文的衔接一律不变，只做局部手术。
3. 逐条对照评价的 issues（severity 高/中优先）与 revision_hints 修订；rubric 中低分维度（<70）重点修补。
4. 修订后正文必须仍是完整一章（篇幅与原章相当），不能只给改动片段。
5. 语言自然、有故事感、口语化，避免文艺腔和 AI 腔；保留本书文风。
6. 亮点（strengths）说明的写得好之处不要改坏。
6'. 【角色-场景合理性】每个登场角色必须与其身份/关系/立场相符，只能出现在合理的场合：
   - 与某组织/地点没有关系边的角色（如非该公司员工），**不得凭空安排其出现在该组织场景**（公司办公室、员工活动等）；
   - 若发现正文中有此类"越界登场"（角色身份/关系与场景不符，如与老板无交集却反复进出公司），
     视为结构性缺陷：删除该出场或改由合理角色承担，不受铁律 2"只做局部手术"限制；
   - 已在设定库/前文确立的"非公司员工""与某人无往来"等边界设定必须严格遵守。
7. 章节标题一律不改：修订是优化不是重写，title 必须等于修订前的原标题，
   不能改成小说名或其他名字（系统会自动沿用原标题，你输出的 title 仅作自检）。

【打破 AI 检测特征（修问题的同时必须兼顾，与下面 L1 量化自检一并执行）】
- 上一段正文的检测指标（句长变异系数 / 极短句占比 / 连接词密度）就是你的量化目标，
  修订后应当明显改善；尤其注意把"整段句长都在 15–30 字"的地方打断。
- 禁止模板式开头（"那是一个……的日子"）；结尾停在具体画面或动作上。

{L1_ANTI_AI_CONSTRAINTS}
"""


class ReviserAgent(Agent[NovelChapter]):
    task_type = "creation"
    temperature = 0.5  # 修订需稳定，温度略低于小说家
    version_count = 1
    mock_output = {
        "title": "雨夜铜币",
        "content": "（Mock 修订版正文）深夜的旧王城只有风在说话。主角坐在占卜房的窗边，盯着左手背上那道早已愈合的印记——它今天又亮了一次。他想起那个自称岚的占卜师说过的话：记忆不是刻在脑子里的，是刻在命里的。窗外的灯一盏盏熄灭，像一段段被篡改的往事。他攥紧拳头，决定明天一早就去旧档案馆查那份本不该存在的出生记录。",
        "note": "已按评价修正：压缩环境描写、补足主角内心动机、弱化说教口吻。",
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        style = get_latest_style_profile(self.db, novel_id)

        chapter_no = 0
        try:
            chapter_no = int(params.get("chapter_no") or 0)
        except (TypeError, ValueError):
            chapter_no = 0
        blueprint = get_active_blueprint(self.db, novel_id)
        # 与 critic/novelist 同口径：设定按章节阶段过滤，避免修订时把未到出场阶段/非本章设定提前带进正文
        stage = derive_stage(chapter_no, blueprint) if chapter_no is not None else None
        active_settings = filter_settings_for_chapter(
            get_settings_snapshot(self.db, novel_id), chapter_no or 0, stage
        )
        settings_text = format_settings_for_prompt(active_settings)

        # 【必现清单】同 novelist：修订时最容易在重写段落里把成组字段删掉，
        # 这里把「要么整体不写，要写就写全」的组单独抽出来显式提醒。
        checklist_text = ""
        try:
            from app.services.setting_checker import extract_checklist, format_required_list

            bp_content = blueprint.content if hasattr(blueprint, "content") else blueprint
            checklist_text = format_required_list(extract_checklist(bp_content, all_settings))
        except Exception:
            pass

        # 【实体硬事实】数据化定档（机构成立时间/人员量级等）：修订时不得把硬事实改歪
        hard_facts_text = format_hard_facts_snapshot(active_settings)

        states = get_recent_story_states(self.db, novel_id)
        states_text = "\n".join(f"#第{s.chapter_no}章：{s.summary}" for s in states) or "（无前文记忆）"

        relations_text = get_graph_relations_text(self.db, novel_id)

        chapters = get_recent_chapters(self.db, novel_id)
        # 最近章节全文（保持衔接与文风连续）；排除本章自己，避免当前正文重复出现
        prev_text = "\n\n".join(
            f"[第{c.chapter_no}章 {c.title or ''}]\n{c.content}"
            for c in reversed(chapters)
            if c.chapter_no != chapter_no
        ) or "（无前文）"

        style_text = "（暂无风格画像）"
        if style:
            style_text = f"traits: {style.traits}\navoid_list: {style.avoid_list}"
        # 全局文风：两部分——蓝图识别（导入蓝图自动更新，冲突时优先）+ 手动添加（不可被覆盖，不冲突也必须遵守）
        blueprint_style = (getattr(novel, "style_directive", None) or "").strip()
        manual_style = (getattr(novel, "style_directive_manual", None) or "").strip()
        if blueprint_style:
            style_text += f"\n【蓝图识别文风（每次导入蓝图自动更新；与手动文风冲突时以本部分为准）】\n{blueprint_style}"
        if manual_style:
            style_text += f"\n【手动文风指示（作者手动设定，不可被覆盖；与蓝图识别文风不冲突时必须严格遵守）】\n{manual_style}"

        current_text = params.get("chapter_text", "")

        # 当前正文的 AI 检测体检（本地启发式，零成本）：把统计指标给优化师当量化目标
        det_text = ""
        if current_text.strip():
            det = detect(current_text)
            bits = []
            if det.burstiness is not None:
                bits.append(f"句长变异系数 burstiness：{det.burstiness}（<0.45 判定'句长过于平均'，人类写作一般 ≥0.7）")
            d = det.density or {}
            if d.get("avg_sentence_len") is not None:
                bits.append(
                    f"平均句长 {d['avg_sentence_len']}、标准差 {d.get('std_sentence_len')}、"
                    f"极短句占比 {d.get('short_ratio')}、超长句占比 {d.get('long_ratio')}"
                )
            if d.get("transition_density") is not None:
                bits.append(f"转折/因果连接词密度 {d['transition_density']}/千字（偏高=叙事'扣链子'痕迹重）")
            if det.regex_hits:
                hits = {k: v for k, v in det.regex_hits.items() if v}
                if hits:
                    bits.append("模板词命中：" + "、".join(f"{k}×{v}" for k, v in hits.items()))
            if det.signals:
                bits.append("检测提示：" + "；".join(det.signals))
            if bits:
                det_text = "\n".join(bits)

        review = params.get("review") or {}
        review_text = ""
        if isinstance(review, dict):
            parts = []
            if review.get("overall_score") is not None:
                parts.append(f"总体分：{review['overall_score']}/100")
            rubric = review.get("rubric") or {}
            if isinstance(rubric, dict) and rubric:
                rows = []
                for k, v in rubric.items():
                    if isinstance(v, dict):
                        s = v.get("score")
                        cm = v.get("comment") or ""
                        rows.append(f"- {k}：{s}/100（{cm}）" if s is not None else f"- {k}：{cm}")
                if rows:
                    parts.append("六维评分：\n" + "\n".join(rows))
            issues = review.get("issues")
            if isinstance(issues, list) and issues:
                rows = []
                for i in issues:
                    if isinstance(i, dict):
                        sev = i.get("severity") or "?"
                        desc = i.get("desc") or ""
                        fix = i.get("suggested_fix")
                        rows.append(f"- [{sev}] {desc}" + (f"（改法：{fix}）" if fix else ""))
                if rows:
                    parts.append("问题清单（优先处理 high/medium）：\n" + "\n".join(rows))
            if review.get("revision_hints"):
                parts.append("修改建议：\n" + "\n".join(f"- {h}" for h in review["revision_hints"]))
            if review.get("strengths"):
                parts.append("亮点（不要改坏）：\n" + "\n".join(f"- {s}" for s in review["strengths"]))
            review_text = "\n\n".join(parts) or "（无评价明细）"

        # 作者通道分两种语义（随本次优化一次性传入，不落库）：
        # 1) 整体作者批注（author_note）= 作者本人发现的新问题/修改要求（可能不在评价清单里）→ 默认要改；
        # 2) 逐条有异议（disagreements）= 作者否决某条评价建议 → 保留原文。
        author_text = ""
        author_note = review.get("author_note") if isinstance(review, dict) else None
        if author_note and str(author_note).strip():
            author_text += (
                "【作者批注·修改要求（作者本人发现的问题/修改要求，优先级最高，先于评价师清单执行）】\n"
                f"- {str(author_note).strip()}\n"
                "作者批注即使不在评价师的问题清单里也必须处理：批注属实（确与上文已确立的事实/设定/"
                "关系/时间线冲突等）→ 按批注意图修改正文；若判断批注不成立或无法修改，必须在 note 中"
                "写明原因，不得静默忽略。\n\n"
            )
        veto_items = []
        disagreements = review.get("disagreements") if isinstance(review, dict) else None
        if isinstance(disagreements, dict) and disagreements:
            for idx, reason in disagreements.items():
                if not reason or not str(reason).strip():
                    continue
                try:
                    display = int(idx) + 1
                except (TypeError, ValueError):
                    display = "?"
                veto_items.append(f"- 第 {display} 条问题：{str(reason).strip()}")
        if veto_items:
            author_text += (
                "【最高指令·作者否决（优先级最高，先于一切；必须逐条执行）】\n"
                + "\n".join(veto_items)
                + "\n以上问题作者已否决：禁止按其 suggested_fix 或任何方式修改对应内容，"
                "相关原文保持一字不动；只处理其他问题，并在 note 中逐条交代被否决项已保留原文。"
            )

        # 组件化上下文（token 预算器按优先级裁剪：硬约束不裁，超窗先裁前文/关系/设定/风格）
        components = [
            ComponentBlock(
                "project",
                f"项目：《{novel.title if novel else novel_id}》",
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "blueprint",
                f"【蓝图（active，修订时不得破坏既有走向）】\n{format_blueprint_for_prompt(blueprint)}",
                PRIORITY_BASE,
            ),
            ComponentBlock(
                "outline",
                f"【本章大纲】{params.get('outline', '（无）')}\n"
                f"章节功能：{params.get('chapter_function', 'progression')}｜写作模式：{params.get('writing_mode', 'draft_free')}",
                PRIORITY_BASE,
            ),
            ComponentBlock(
                "settings",
                f"【相关设定】\n{settings_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "relations",
                f"【实体关系图谱（修订时不得与已确立关系矛盾）】\n{relations_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "memory",
                f"{format_memory_prompt(get_latest_memory(self.db, novel_id))}\n\n【前文记忆】\n{states_text}",
                PRIORITY_MEMORY,
            ),
            ComponentBlock(
                "prev_text",
                f"【最近章节全文（保持衔接与文风连续）】\n{prev_text}",
                PRIORITY_CONTEXT,
            ),
            ComponentBlock(
                "style",
                f"【L2 风格画像 / 全局文风】\n{style_text}",
                PRIORITY_STYLE,
            ),
            ComponentBlock(
                "chapter_text",
                f"【本章当前正文（要修订的文本）】\n{current_text}",
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "det",
                f"【当前正文的 AI 检测体检（本地启发式，修订时尽量改善这些指标）】\n{det_text or '（无可计算指标）'}",
                PRIORITY_CONTEXT,
            ),
            ComponentBlock(
                "review",
                f"【评价师报告（修订依据）】\n{review_text}",
                PRIORITY_BASE,
            ),
        ]
        if checklist_text:
            components.append(
                ComponentBlock(
                    "checklist",
                    f"【必现清单（硬约束，重写段落时也不可丢项）】\n{checklist_text}",
                    PRIORITY_REQUIRED,
                )
            )
        if hard_facts_text:
            components.append(
                ComponentBlock(
                    "entity_facts",
                    f"{hard_facts_text}\n修订时不得把已定档的实体硬事实改歪；"
                    "若要体现变化（扩张/增减），仅当评价/批注明确要求且前文有铺垫时才允许，否则沿用硬事实。",
                    PRIORITY_REQUIRED,
                )
            )
        if author_text:
            components.append(ComponentBlock("author", author_text, PRIORITY_REQUIRED))
        components.append(
            ComponentBlock(
                "instruction",
                "请输出修订后的完整章节正文 JSON（title/content/note）。",
                PRIORITY_REQUIRED,
            )
        )
        user_content = "\n\n".join(c.content for c in components)
        return ContextPack(
            novel_id=novel_id,
            agent="reviser",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            components=components,
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> NovelChapter:
        return NovelChapter.model_validate_json(text.strip())
