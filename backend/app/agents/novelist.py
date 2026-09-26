"""小说家（Novelist）：基于装配好的上下文，产出章节正文（单版本生成，生成即定稿）。"""
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
    get_latest_style_profile,
    get_novel,
    get_recent_chapters,
    get_recent_story_states,
    get_settings_snapshot,
    format_settings_for_prompt,
    get_active_blueprint,
    format_blueprint_for_prompt,
    get_graph_relations_text,
    get_latest_memory,
    format_memory_prompt,
    derive_stage,
    filter_settings_for_chapter,
    get_chapter_author_directives,
    STAGE_LABELS,
)
from app.agents.l1 import L1_ANTI_AI_CONSTRAINTS
from app.agents.platform_rules import (
    PLATFORM_SIGNING_HEADER,
    PLATFORM_SIGNING_NOVEL,
    PLATFORM_ANTI_CLICHE,
    get_background_generation_scope,
    format_genres_direction,
    format_genre_storytelling_rules,
)
from app.schemas.agents import NovelChapter
from app.services.detector import detect
from app.services.entity_checker import format_hard_facts_snapshot
from app.services.era_industry import format_era_research_for_prompt

SYSTEM_PROMPT = f"""你是「小说家」，一部小说的写作者。
你的任务：基于给定的大纲/前文/设定，写出一个章节的正文。
- 输出必须是严格的 JSON：{{"title": "本章标题", "content": "章节正文（不少于200字）", "note": "自评：本章用到的设定、待回收伏笔"}}
- 标题要求：简洁有力、能概括本章核心；若作者已给定标题则原文沿用。
- 正文就是正文本身，不要把 JSON 解释写进正文。

写作铁律（追加）：
- 【作者定向·本章写法要点】当【本章大纲】含"写法要点（作者定向）"时，其中进入/触发方式、风格基调、主角反应弧、核心冲突落点、爽点类型是**作者选定的执行要求，不可替换演法**——正文必须逐项照此演：触发方式照写、风格基调贯穿全章、主角反应按"从什么到什么"的弧线推进、核心冲突落在指定场面、爽点给足指定类型；只允许在语言呈现层面自由发挥，不允许在"演什么、怎么演"层面自行换成另一种演法。若确因素材冲突必须微调，只能在保持该演法精神的前提下调整具体细节。
- 【角色-场景合理性】每个登场角色必须与其身份/关系/立场相符，只能出现在合理的场合：
  - 与某组织/地点没有关系边的角色（如非该公司员工），**不得凭空安排其出现在该组织场景**（公司办公室、员工活动等）；
  - 若该角色与前文已确立的信息源/人物关系不符（如与老板无交集却反复进出公司），应删除该出场或改由合理角色承担；
  - 已在设定库/前文确立的"非公司员工""与某人无往来"等边界设定必须严格遵守，不得擅自让角色越界登场。
- 【设定节制·不铺陈背景】设定库/蓝图/记忆里的背景信息（人物身世、组织历史、世界规则、人物完整外貌等）只作为"一致性依据"注入——正文只写**当下情节需要呈现的部分**，按剧情进展自然流露（一句话点破、一个动作带过、一段对话暗示），禁止把某个人物/组织的完整背景一次性写成大段说明文字，也禁止同一章内连续堆叠多条设定说明；设定细节是"数据库"，不是"说明书"。
- 【数字具体化】凡涉及金额、数量、时长、尺寸、参数等可量化的信息，必须落到**具体数字**上（如"8976 元""8 颗毛坯""良率 80%""348 小时"），不得用"一些/不少/很多/很快"等模糊词蒙混；数字要贴合角色处境与行业常理（刚入职的人攒不下八位数），并前后保持一致、可复核。
- 【结尾指向下一章】章节结尾必须落在「下一章要解决的问题/悬念」上：可以是一个新问题、一个未完成的动作、一个被切断的对话或一个悬而未决的场面，让读者有动力点开下一章；不必每章都是强冲突钩子（弱收尾也可以），但结尾要留出"接下来怎么办"的推进指向，不允许正文在完成本件事后就戛然而止没有下文牵引。
- 【反雷同·原创性】借鉴同类题材的**结构与节奏**可以，但具体情节、桥段、名场面、人物、台词必须原创：不得连细节带结果复刻任何已出版小说/影视中可辨识的具体桥段与名场面（雷同即抄袭）；也不得把现实中某位知名人物的具体事件、语录、数据安到虚构主角身上——主角的行业成长脉络可以借鉴真实行业的普遍路径（如从顾问做到机构、从线下到线上爆火），但主角身份、机构名、具体数字与经历必须原创。
- 【写后自检·身份一致性】完稿后**逐角色**对照其设定身份（职业/年龄/生活环境/成长背景），重读一遍自己的正文，核对每个角色的外貌、穿着、手部、习惯、行为细节：凡与该身份生活经验/身体特征相矛盾的细节**必须当场改写**——以身份为标尺，不依赖任何禁词清单，无论是什么模板的套话都算不合格。note 字段必须写明自检结论："身份自检：已逐角色核对 <N> 个登场角色的细节，无身份不符/套话描写"（若改写过则如实说明改了哪处）。

{PLATFORM_SIGNING_HEADER}

{PLATFORM_SIGNING_NOVEL}

{PLATFORM_ANTI_CLICHE}

{L1_ANTI_AI_CONSTRAINTS}
"""

class NovelistAgent(Agent[NovelChapter]):
    task_type = "creation"
    # 0.82：比原 0.75 略微放开，让句长/用词分布更散（AI 检测器抓的是"过稳"的分布）；
    # 再高会开始丢设定一致性，这个值是质量与"人味"的折中。
    temperature = 0.82
    version_count = 1
    mock_output = {
        "title": "雨夜铜币",
        "content": "（Mock 章节正文）深夜的旧王城只有风在说话。主角坐在占卜房的窗边，盯着左手背上那道早已愈合的印记——它今天又亮了一次。他想起那个自称岚的占卜师说过的话：记忆不是刻在脑子里的，是刻在命里的。窗外的灯一盏盏熄灭，像一段段被篡改的往事。他攥紧拳头，决定明天一早就去旧档案馆查那份本不该存在的出生记录。雨又下起来了，铜币在怀里沉甸甸的，仿佛在回应他加速的心跳。他在心里默默盘算：如果自己的出生记录是假的，那城门口那张通缉令上的人，也许并不陌生。这一夜，他几乎没合眼。",
        "note": "本章用到的设定：占卜房、左手印记；待回收伏笔：半枚印记的来信。",
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        style = get_latest_style_profile(self.db, novel_id)

        # 题材特化规则（条件注入）：仅现实事业流生效（realistic + 都市/职场/教育等标签）；
        # 架空/玄幻/全民神祗等其它类型返回空串，不注入任何特化规则，避免跨题材冲突。
        genre_block = format_genre_storytelling_rules(
            getattr(novel, "background_type", None) if novel else None,
            (novel.genres if novel else None) or [],
        )
        system_prompt = SYSTEM_PROMPT + (("\n\n" + genre_block) if genre_block else "")

        # 设定：M0 骨架全量截断给（M1 起由 RAG + POV 裁剪精确装配）
        # 按写作进度过滤：隐藏的不给、未到生效章范围的不给、阶段不命中的不给，避免后期设定提前出现
        chapter_no = 0
        try:
            chapter_no = int(params.get("chapter_no") or 0)
        except (TypeError, ValueError):
            chapter_no = 0
        blueprint = get_active_blueprint(self.db, novel_id)
        stage = derive_stage(chapter_no, blueprint)
        all_settings = get_settings_snapshot(self.db, novel_id)
        active_settings = filter_settings_for_chapter(all_settings, chapter_no, stage)
        settings_text = format_settings_for_prompt(active_settings)

        # 【L3·必现清单】把「必须同时出现的成组内容」从蓝图长句里单独抽出来显式约束。
        # 根因：这类规则原本埋在 288 字的 world_rule.detail 里（位于蓝图全文 ~80% 处），
        # 模型注意不到 → 第 2、3 章都漏写了面板的「兴趣爱好」字段。这里单独成条、写前注入。
        checklist_text = ""
        try:
            from app.services.setting_checker import extract_checklist, format_required_list

            bp_content = blueprint.content if hasattr(blueprint, "content") else blueprint
            checklist = extract_checklist(bp_content, active_settings)
            checklist_text = format_required_list(checklist)
        except Exception:  # 抽取失败不影响写作主流程
            pass

        # 【实体硬事实】数据化定档（机构成立时间/人员量级等），写前注入防自造事实
        hard_facts_text = format_hard_facts_snapshot(active_settings)

        # 【年代×行业背景研究】时代常识参考（开局年份 + 按时间演进的形态/红线）：
        # 与蓝图 timeline 硬事实配合——本章所处的故事时间点对应哪个年份，就只用该年份已存在的事物
        era_block = format_era_research_for_prompt(novel.era_research if novel else None)

        # 前文记忆：最近 story_state 摘要 + 各章角色状态快照（方案1：让小说家直接读到角色当前状态，最新章在前）
        states = get_recent_story_states(self.db, novel_id)
        states_text = "\n".join(f"#第{s.chapter_no}章：{s.summary}" for s in states) or "（无前文记忆）"
        char_states_lines: list[str] = []
        for s in states:  # get_recent_story_states 按章号降序 → 最新章在前（时间线最新优先）
            for cs in s.character_states or []:
                cname = (cs or {}).get("character")
                cstate = (cs or {}).get("state")
                if cname and cstate:
                    char_states_lines.append(f"第{s.chapter_no}章 · {cname}：{cstate}")
        char_states_text = "\n".join(char_states_lines) or "（最近几章无角色状态记录）"

        # 实体关系图谱：写作一致性对照（不得与已确立关系矛盾，新关系可在正文中自然建立）
        relations_text = get_graph_relations_text(self.db, novel_id)

        # 最近章节全文（保文风连续性）
        chapters = get_recent_chapters(self.db, novel_id)
        # 重新生成=新增：本章自己的旧正文（若已定稿进 Chapter 表）不得作为参考，
        # 必须从上下文排除，否则 AI 会基于旧稿改写而不是全新创作。取前文 3 章再过滤，保证仍有 2 章衔接上下文。
        if params.get("regenerate"):
            chapters = get_recent_chapters(self.db, novel_id, limit=3)
            try:
                cur_no = int(params.get("chapter_no") or 0)
            except (TypeError, ValueError):
                cur_no = 0
            if cur_no:
                chapters = [c for c in chapters if c.chapter_no != cur_no]
        prev_text = "\n\n".join(f"[第{c.chapter_no}章 {c.title or ''}]\n{c.content}" for c in reversed(chapters)) or "（无前文）"

        # L2 风格画像（存在则注入）
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

        # L3 节奏/心态指令：由 chapter_function 与写作模式运行时派生（§5.7）
        chapter_function = params.get("chapter_function", "progression")
        writing_mode = params.get("writing_mode", "draft_free")
        if chapter_function in ("climax", "turning"):
            l3 = "【L3·本章节奏】加快节奏、冲突升级、节拍短促有力。"
        elif chapter_function in ("buildup", "interlude"):
            l3 = "【L3·本章节奏】舒缓从容、不急于推进情节，把细节与画面写充分。"
        else:
            l3 = "【L3·本章节奏】按大纲节拍稳步推进，保持叙事感。"
        if writing_mode == "draft_free":
            l3 += " 心态：不必追求完美，写到哪算哪，让故事自然流淌。"
        else:  # outline_guided
            l3 += f" 心态：完成本章目标——{params.get('goal', '')}"

        # 时间线提示：当前章节号 + 所处阶段（有蓝图可推导时），约束 AI 不提前引入后期设定
        if chapter_no > 0:
            l3 += f"\n【L3·时间线】当前是第 {chapter_no} 章。"
            if stage:
                l3 += f" 故事处于【{STAGE_LABELS.get(stage, stage)}】阶段，只使用当前阶段已出现的设定与伏笔，不得提前引入后期才登场的内容。"
            if era_block:
                l3 += " 结合【年代×行业背景研究】与蓝图时间线（timeline）判断本章所处的故事年份，只用该年份已存在的事物（其中红线带时间前提，只拦时间错位）。"

        # L3 反 AI 味：把上一章的实测统计交给模型，避免它模仿自己上一章的节奏
        # （续写最容易出的问题：越写句长越均匀，AI 检测分数逐章恶化）
        if chapters:
            try:
                det = detect(chapters[0].content or "")
                bits: list[str] = []
                if det.burstiness is not None:
                    bits.append(f"句长变异系数 {det.burstiness}（人类写作一般 ≥0.7，<0.45 偏平）")
                d = det.density or {}
                if d.get("short_ratio") is not None:
                    bits.append(f"极短句 {d['short_ratio']:.0%}（目标 ≥15%）")
                if d.get("transition_density") is not None:
                    bits.append(f"连接词密度 {d['transition_density']}/千字（目标 ≤3.5）")
                if bits:
                    l3 += (
                        f"\n【L3·反 AI 味·上一章实测（第 {chapters[0].chapter_no} 章）】"
                        + "、".join(bits)
                        + "。本章不要延续上一章的句子节奏，要明显更有起伏。"
                    )
            except Exception:  # 统计失败不影响写作主流程
                pass

        # L3 信息控制（§5.3 info_control，M1 补强）：读者/主角知道什么、必须隐瞒什么
        info = params.get("info_control") or {}
        if info:
            l3 += (
                f"\n【L3·信息控制】读者已知：{info.get('reader_knows', '无')}；"
                f"主角已知：{info.get('protagonist_knows', '无')}；"
                f"必须向读者隐瞒：{info.get('must_hide', '无')}；"
                f"只能点到为止：{info.get('hint_only', '无')}。"
                f"正文不得提前泄露『必须隐瞒』的内容，伏笔只能暗示。"
            )

        # 组件化上下文（token 预算器按优先级裁剪：硬约束不裁，超窗先裁最近全文/风格）
        components = [
            ComponentBlock(
                "project",
                (
                    f"项目：《{novel.title if novel else novel_id}》\n"
                    f"项目前提：{novel.premise if novel and novel.premise else '（未填）'}\n"
                    f"世界背景类型：{(novel.background_type if novel else None) or 'realistic'}\n\n"
                    f"{get_background_generation_scope(novel.background_type if novel else None)}\n\n"
                    f"{format_genres_direction((novel.genres if novel else None) or [])}"
                ),
                PRIORITY_REQUIRED,
            ),
            ComponentBlock(
                "blueprint",
                f"【蓝图（active）】\n{format_blueprint_for_prompt(get_active_blueprint(self.db, novel_id))}",
                PRIORITY_BASE,
            ),
            ComponentBlock(
                "outline",
                f"【本章大纲】{params.get('outline', '（自由续写，无大纲）')}\n"
                f"章节功能：{chapter_function}｜写作模式：{writing_mode}",
                PRIORITY_BASE,
            ),
            ComponentBlock("l3", l3, PRIORITY_BASE),
            ComponentBlock(
                "settings",
                f"【相关设定】\n{settings_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "relations",
                f"【实体关系图谱（写作时不得与已确立关系矛盾，新关系可在正文中自然建立，下一章提取师会记录）】\n{relations_text}",
                PRIORITY_SETTING,
            ),
            ComponentBlock(
                "memory",
                f"{format_memory_prompt(get_latest_memory(self.db, novel_id))}\n\n【前文记忆】\n{states_text}",
                PRIORITY_MEMORY,
            ),
            ComponentBlock(
                "char_states",
                f"【角色当前状态（最近几章快照，最新章在前；本章涉及其中的角色时，须延续其最新状态，不得沿用已被推翻的旧状态）】\n{char_states_text}",
                PRIORITY_MEMORY,
            ),
            ComponentBlock(
                "prev_text",
                f"【最近章节全文】\n{prev_text}",
                PRIORITY_CONTEXT,
            ),
            ComponentBlock(
                "style",
                f"【L2 风格画像】\n{style_text}",
                PRIORITY_STYLE,
            ),
            ComponentBlock(
                "goal",
                f"【本章目标】{params.get('goal', '')}",
                PRIORITY_BASE,
            ),
        ]
        if checklist_text:
            # 放在最靠近"开始写"的位置：末尾注意力最高，硬约束不应被埋在长上下文中间
            components.append(
                ComponentBlock(
                    "checklist",
                    f"【必现清单（硬约束，优先级高于一切文笔要求）】\n{checklist_text}\n"
                    "以上每一组都是『要么整体不写，要写就必须写全』。动笔前先确认本章会涉及哪几组，"
                    "写完再逐组自查一遍，缺一项就补进去。",
                    PRIORITY_REQUIRED,
                )
            )
        if hard_facts_text:
            components.append(
                ComponentBlock(
                    "entity_facts",
                    f"{hard_facts_text}\n"
                    "若本章需要推进这些实体的事实变化（如机构扩张、人员增减），"
                    "必须先在前文/大纲中有铺垫，且该变化会在下一章回写设定卡；否则一律沿用硬事实。",
                    PRIORITY_REQUIRED,
                )
            )
        if era_block:
            components.append(
                ComponentBlock(
                    "era",
                    f"【年代×行业背景研究（时代常识；红线带时间前提，只拦时间错位）】\n{era_block}",
                    PRIORITY_SETTING,
                )
            )
        # 作者对本章的历史修改意见（意见持久化）：作者在之前版本优化/批注时指出过的问题，
        # 本次重新生成/续写必须规避或修正。放在最靠近"开始写"的位置，硬约束不埋在中间。
        author_directives = get_chapter_author_directives(self.db, novel_id, chapter_no)
        if author_directives:
            directives_text = "\n".join(f"- {d['text']}" for d in author_directives)
            components.append(
                ComponentBlock(
                    "author_directives",
                    "【作者对本章的历史修改意见（作者在之前版本明确指出过的问题，本次生成必须遵守；"
                    "与【本章大纲】/【本章目标】冲突时以本意见为准）】\n"
                    f"{directives_text}",
                    PRIORITY_REQUIRED,
                )
            )
        # 场景执行清单（作者逐字段确认的场景骨架 + 每个场景选定的写法提案）：
        # 硬约束——本章正文必须严格按场景清单写，不得增删场景、不得改变每场景的
        # 「目标→冲突→结果」；每个场景按作者选定的写法提案扩写。
        scene_plan = params.get("scene_plan") or []
        if isinstance(scene_plan, list) and scene_plan:
            scene_lines = []
            for s in scene_plan:
                if not isinstance(s, dict):
                    continue
                line = (
                    f"场景{s.get('scene_index', '?')}：\n"
                    f"  地点：{s.get('location') or '（未定）'}\n"
                    f"  人物：{s.get('participants') or '（未定）'}\n"
                    f"  目标：{s.get('goal') or '（未定）'}\n"
                    f"  冲突：{s.get('conflict') or '（未定）'}\n"
                    f"  结果：{s.get('outcome') or '（未定）'}"
                )
                if (s.get("proposal") or "").strip():
                    line += f"\n  写法（作者选定的提案，按此扩写）：{s['proposal']}"
                scene_lines.append(line)
            if scene_lines:
                components.append(
                    ComponentBlock(
                        "scene_plan",
                        "【场景执行清单（硬约束，优先级高于文笔要求；与【本章大纲】冲突时以本清单为准）】\n"
                        "你必须严格按以下场景清单写作：不得增删场景，不得改变每个场景的「目标→冲突→结果」，"
                        "并按各场景选定的「写法」扩写：\n"
                        + "\n".join(scene_lines),
                        PRIORITY_REQUIRED,
                    )
                )
        user_content = "\n\n".join(c.content for c in components)
        return ContextPack(
            novel_id=novel_id,
            agent="novelist",
            system_prompt=system_prompt,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            components=components,
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> NovelChapter:
        return NovelChapter.model_validate_json(text.strip())
