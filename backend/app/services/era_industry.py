"""时代行业研究的渲染与注入：把 novel.era_research 变成各角色的上下文。

## 架构演进（重要）
最初方案是「代码内置知识包」（如 2000 年代人才中介），缺点是换一本年代/行业不同的
小说就要开发一个新包。改为**运行时按需生成**：

- 生成蓝图前，由「时代行业研究员」（agents/era_researcher.py）对当前小说现场做一次
  「年代×行业」研究，产出结构化知识包，落库到 novel.era_research（JSONB，作者可在
  项目设置页查看/修改）；
- 本模块只负责把这份研究渲染成各角色需要的注入文本：
  - 蓝图师 / 设定抽取师：完整研究（机构形态/老板画像/业务清单/位置/演进/雷点）；
  - 评价师：精简快照（年代/行业/时代雷点，用于判断机构设定是否符合当时情况）；
- 换一本小说自动重新研究，不依赖开发加知识包。

研究是"时代常识参考"，作者在 novel.era_research 里改过的内容优先。
"""
import logging

logger = logging.getLogger(__name__)


def _get(research: dict | None, key: str, default=""):
    if not isinstance(research, dict):
        return default
    v = research.get(key, default)
    if v is None:
        return default
    return v


def format_era_research_for_prompt(research: dict | None) -> str:
    """完整研究包 → 注入文本（给蓝图师 / 设定抽取师）。无研究返回空字符串。"""
    if not isinstance(research, dict) or not research:
        return ""
    era = _get(research, "era")
    industry = _get(research, "industry")
    if not era and not industry:
        # 研究存在但判定无现实参照（纯架空等），不注入
        return ""
    bits: list[str] = []
    bits.append(f"时代定位：{era or '（未明确）'}；行业：{industry or '（未明确）'}")
    start_year = _get(research, "story_start_year")
    if start_year:
        bits.append(
            f"故事开局年份：{start_year}（时间锚点；故事从开局年份起按时间线向后推进，不受时代定位标签的年份限制，各年份形态看下方演进时间轴）"
        )
    forms = _get(research, "organization_forms", [])
    if isinstance(forms, list) and forms:
        bits.append("机构典型形态：" + "；".join(str(x) for x in forms))
    boss = _get(research, "boss_portrait")
    if boss:
        bits.append(f"老板/负责人画像：{boss}")
    biz = _get(research, "business_list", [])
    if isinstance(biz, list) and biz:
        bits.append("业务范围：" + "；".join(str(x) for x in biz))
    loc = _get(research, "location_pattern")
    if loc:
        bits.append(f"位置/布局规律：{loc}")
    evo = _get(research, "evolution", [])
    if isinstance(evo, list) and evo:
        bits.append("行业阶段演进时间轴（从开局年份起覆盖续写年份，按当前写到哪一年对照）：" + "；".join(str(x) for x in evo))
    flags = _get(research, "era_mismatch_red_flags", [])
    if isinstance(flags, list) and flags:
        bits.append("时代错位雷点（写作红线，严禁出现）：" + "；".join(str(x) for x in flags))
    return (
        "【年代×行业背景研究·本项目专属（由研究员按本书现场生成，作者可改）】\n"
        + "\n".join(bits)
        + "\n用它把机构/老板/业务写得符合该年代该行业的真实样貌。"
        "红线均带时间前提（某年前没有/某年之后才出现），只拦「时间错位」——"
        "故事写到更晚年份时，该年份已出现的科技/政策/业态是正常设定，不要误判为雷点。"
        "写作某章节时，按蓝图时间线（timeline）判断本章所处的故事时间点，只使用该时间点已存在的事物；"
        "与作者明确写出的设定冲突时，以作者设定为准。"
    )


def format_era_research_critic_snapshot(research: dict | None) -> str:
    """精简快照 → 注入评价师（判断"机构是否符合当时情况"的依据）。无研究返回空字符串。"""
    if not isinstance(research, dict) or not research:
        return ""
    era = _get(research, "era")
    industry = _get(research, "industry")
    flags = _get(research, "era_mismatch_red_flags", [])
    if not era and not industry and not flags:
        return ""
    lines = [f"- 本书时代定位：{era or '（未明确）'}；行业：{industry or '（未明确）'}"]
    start_year = _get(research, "story_start_year")
    if start_year:
        lines.append(f"- 故事开局年份：{start_year}（时间锚点，各年份形态看研究 evolution 时间轴，不限于定位标签年份）")
    if isinstance(flags, list) and flags:
        lines.append("- 该年代/行业常见时代错位（按时间前提核对，正文出现即为红线）：" + "；".join(str(x) for x in flags))
    return (
        "【年代×行业研究·精简快照（本项目专属）】\n"
        + "\n".join(lines)
        + "\n现实题材下，评价本章涉及的机构/老板/业务时，对照此快照判断是否符合当时情况："
        "先判断本章所处的故事时间点，只按该时间点的红线核对——红线均带时间前提（某年前没有/"
        "某年之后才出现），写到更晚年份时已出现的科技/政策/业态是正常设定，不算雷点。"
    )
