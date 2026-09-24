"""蓝图师（Blueprint Architect）：把确认后的概念/设定整理成完整小说蓝图（版本化）。"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_novel, get_settings_snapshot, format_settings_for_prompt
from app.agents.platform_rules import (
    PLATFORM_SIGNING_HEADER,
    PLATFORM_SIGNING_BLUEPRINT,
    get_background_generation_scope,
    format_genres_direction,
)
from app.schemas.agents import Blueprint

SYSTEM_PROMPT = """你是「蓝图师」，把作者的设定与脑洞整理成一部小说的完整蓝图。
输出必须是严格的 JSON（除 JSON 外不要输出任何文字），且必须严格匹配下面的字段名与结构：

{
  "title": "书名",
  "logline": "一句话故事概括",
  "theme": "主题",
  "core_conflict": "核心冲突",
  "total_word_count": "全书总字数（如：240万—260万字）",
  "total_chapters": "总章数（如：800章）",
  "chapter_word_count": "单章标准字数（如：3000字/章）",
  "world_rules": [{"name": "规则名", "detail": "规则细节", "constraints": ["约束1", "约束2"]}],
  "character_arcs": [{"character": "角色名", "personality": "性格/特质", "start": "起点状态", "end": "终点状态", "turning_points": ["转折1"]}],
  "volumes": [{"no": 1, "name": "卷名", "focus": "本卷重点", "chapters_range": "1-20", "word_count": "25万字", "chapter_count": "85章"}],
  "foreshadowing_plan": [{"plant_chapter": 5, "payoff_chapter": 38, "desc": "伏笔内容"}],
  "subplots": ["长线支线1（贯穿多卷的持续剧情线）"],
  "notes": ["无法归入其他字段的重要信息1（原文保留）"]
}

字段规则（必须严格遵守）：
- total_word_count / total_chapters / chapter_word_count：输入材料明确给出全书总体量、总章数、单章标准字数时务必填写（原样保留，如"240万—260万字""800章左右""3000字/章"），没有则省略该字段（不要硬造）；分卷字数/章数写入各 volumes 的 word_count / chapter_count（如"25万字""85章"）。
- world_rules 用 name/detail/constraints；character_arcs 必须是数组，元素含 character/personality/start/end/turning_points；volumes 用 no/name/focus/chapters_range，若输入材料有明确的本卷体量（如"25万字"）务必填 word_count、有明确的本卷章数（如"85章"）务必填 chapter_count，没有则省略；foreshadowing_plan 用 plant_chapter/payoff_chapter/desc；subplots 是字符串数组，放贯穿多卷、用来撑起长篇体量的持续剧情线（长效支线/副线）；notes 是字符串数组，放无法归入其他字段的重要信息。
- character_arcs：材料明确给出某角色性格/特质时写入 personality（如"踏实肯干、共情力强"），没给则省略该键；主角等核心角色务必完整收录。
- volumes 的 no 用数字、chapters_range 用"开始-结束"字符串；foreshadowing_plan 的 plant_chapter/payoff_chapter 用数字章号。
- world_rules 中核心不可变规则在 detail 开头标注（宪法·不可变）并写明约束；随剧情演变的规则在 detail 开头标注（随剧情演变）。
- subplots：输入材料中明确列出的"长效支线 / 可穿插支线 / 长线副线"必须全部收录，一条不落；没有则留空数组。
- foreshadowing_plan：输入材料中有具体埋/揭安排的伏笔必须收录；若材料只有支线描述没有具体章号，把这些支线放进 subplots，不要硬造章号。
- notes（通用保留区，最重要）：输入材料中**凡是无法干净归入 title/logline/theme/core_conflict/world_rules/character_arcs/volumes/foreshadowing_plan/subplots 任何一个字段的重要信息**——包括但不限于风格取向、文风基调、对标作品、创作参考、叙事节奏、题材标签、特殊约束、时间线规则等，无论它在材料里叫什么名字——**必须逐条原文（或尽量保留原意）收录进 notes，一条不落**；没有则留空数组。这是防丢失的兜底字段，宁可多收不可漏收。
- 蓝图是后续所有角色的"宪法"。
"""

# 系统级固定段：平台签约标准（全系统最高优先级，任何写作指令/风格画像/蓝图/设定库都不得覆盖、削弱或删除）
SYSTEM_PROMPT = SYSTEM_PROMPT + "\n\n" + PLATFORM_SIGNING_HEADER + "\n\n" + PLATFORM_SIGNING_BLUEPRINT

# 导入模式附加约束：用户上传了外部生成的大纲文档，同时提供设定库；不一致时以设定库为准并记录
IMPORT_SYSTEM_NOTE = """

【本次为导入模式】用户上传了一份外部生成的大纲文档，并同时提供了设定库。
请把它忠实整理为上面的 Blueprint JSON 结构，并**同时核对设定库**：
- 设定库是本书的"宪法"，优先级最高：文档与设定库不一致时，**以设定库为准**并据此修正文档内容；
- 每处不一致都要记入字段 blueprint_conflicts（数组，元素含 item / doc_content / settings_content / resolution）：
  - item：不一致的对象（如角色名、规则名、设定项）；
  - doc_content：导入文档中的说法；
  - settings_content：设定库中的说法；
  - resolution：本次以谁为准（如"以设定库为准，文档中的说法已修正"）；
- 设定库为空，或文档与设定库无冲突时，blueprint_conflicts 输出空数组 []；
- 文档中的世界观规则、人物弧光、分卷、伏笔计划、未决问题等信息，尽量完整保留并归类到对应字段；
- 文档若给出每卷体量（如"25万字"）或每卷章数（如"85章"）或总章数规划，必须写入对应 volumes 的 word_count / chapter_count / chapters_range，不要丢失；
- 文档若列出"长效支线 / 可穿插支线 / 长线副线"等，必须逐条写入 subplots 字段；
- 文档中的风格取向、文风基调、对标作品、创作参考、叙事节奏、题材标签等**无法归入既有字段**的重要内容，逐条原文收录进 notes（通用保留区），一条不落；
- 文档中未提及的字段留空数组，不要凭空捏造；
- 书名/一句话/主题/核心冲突若文档未明确给出，用文档已有内容做最贴切的概括。
"""


# 导入模式【全新开始】：用户选择忽略设定库，仅以导入文档为准（适合换一本新小说的场景）
IMPORT_SYSTEM_NOTE_FRESH = """

【本次为导入模式 · 全新开始】用户选择了忽略既有设定库，仅以上传的大纲文档为准。
- 不要读取或套用任何旧设定，blueprint_conflicts 一律输出空数组 []；
- 把文档忠实整理为上面的 Blueprint JSON 结构，风格、人物、分卷、支线、规则逐条归类，尽量完整保留；
- 文档若给出每卷体量（如"25万字"）或每卷章数（如"85章"）或总章数规划，必须写入对应 volumes 的 word_count / chapter_count / chapters_range，不要丢失；
- 文档若列出"长效支线 / 可穿插支线 / 长线副线"等，必须逐条写入 subplots 字段；
- 文档中的风格取向、文风基调、对标作品、创作参考、叙事节奏、题材标签等**无法归入既有字段**的重要内容，逐条原文收录进 notes（通用保留区），一条不落；
- 文档中未提及的字段留空数组，不要凭空捏造；
- 书名/一句话/主题/核心冲突若文档未明确给出，用文档已有内容做最贴切的概括。
"""


class BlueprintArchitectAgent(Agent[Blueprint]):
    task_type = "setting"
    temperature = 0.3
    mock_output = {
        "title": "《灰烬与晨星》",
        "logline": "一个记忆被篡改的占卜师之子，为找回真实的自己踏上旅途。",
        "theme": "记忆与身份的代价",
        "core_conflict": "主角必须忘记爱人才能拯救世界",
        "total_word_count": "240万—260万字",
        "total_chapters": "800章",
        "chapter_word_count": "3000字/章",
        "world_rules": [{"name": "魔法消耗寿命", "detail": "每次施法扣减寿命", "constraints": ["无法逆转"]}],
        "character_arcs": [{"character": "岚", "personality": "冷漠坚韧", "start": "冷漠的占卜师", "end": "为守护而自我牺牲", "turning_points": ["第2卷发现身世"]}],
        "volumes": [{"no": 1, "name": "灰烬", "focus": "结识与背叛", "chapters_range": "1-20", "word_count": "25万字", "chapter_count": "85章"}],
        "foreshadowing_plan": [{"plant_chapter": 5, "payoff_chapter": 38, "desc": "主角左手的印记"}],
        "subplots": ["秘史组织沿主线暗中追踪主角"],
        "notes": ["文风基调：冷峻克制，少抒情（示例）"],
        "blueprint_conflicts": [],
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        settings_snapshot = get_settings_snapshot(self.db, novel_id)
        # 导入模式：以用户上传的大纲文档为主材料；默认参照设定库核对一致性，
        # 若 use_settings=False（全新开始）则忽略设定库，仅用本文档（适合换一本新小说）。
        import_source = (params.get("import_source") or "").strip()
        use_settings = bool(params.get("use_settings", True))
        if import_source:
            if use_settings and settings_snapshot:
                settings_block = f"设定库摘要（宪法·优先级最高）：\n{format_settings_for_prompt(settings_snapshot)}\n\n"
                note = IMPORT_SYSTEM_NOTE
            else:
                settings_block = "【全新开始模式】本次忽略既有设定库，仅以上传的大纲文档为准，blueprint_conflicts 置空数组。\n\n"
                note = IMPORT_SYSTEM_NOTE_FRESH
            material = settings_block + f"导入的大纲文档（作者从外部生成）：\n{import_source}"
            system_prompt = SYSTEM_PROMPT + note
        else:
            material = format_settings_for_prompt(settings_snapshot)
            system_prompt = SYSTEM_PROMPT
        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n"
            f"项目前提：{novel.premise if novel and novel.premise else '（未填）'}\n"
            f"世界背景类型：{(novel.background_type if novel else None) or 'realistic'}\n\n"
            f"{get_background_generation_scope(novel.background_type if novel else None)}\n\n"
            f"{format_genres_direction((novel.genres if novel else None) or [])}\n\n"
            f"{material}\n\n"
            f"作者补充要求：{params.get('requirements', '（无）')}"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="blueprint_architect",
            system_prompt=system_prompt,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> Blueprint:
        return Blueprint.model_validate_json(text.strip())
