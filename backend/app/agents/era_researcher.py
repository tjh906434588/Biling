"""时代行业研究员（Era Researcher）：按小说的「年代×行业」现场研究背景知识包。

## 为什么需要它
机构（如「江城人才信息服务部」）只有一句散文、老板/业务是否符合当时情况无从核对，
根因是设定生成时没有任何"该年代该行业长什么样"的常识。但常识**不能写死在代码里**
（换一本年代/行业不同的小说就要开发一个新包）。

解法：每次生成蓝图前，由本研究员对当前这本小说现场做一次「年代×行业」研究，
产出结构化知识包（机构形态/老板画像/业务清单/位置规律/行业演进/时代雷点），
落库到 novel.era_research，作者可在项目设置页查看/修改；后续设定生成与评价全部复用。
换一本小说自动重新研究，不依赖开发加知识包。
"""
import uuid
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.context import get_novel
from app.schemas.agents import EraResearch

SYSTEM_PROMPT = """你是「时代行业研究员」。根据作者提供的小说信息，研究这部小说所处「年代」+「行业」的真实样貌，为后续机构/老板/业务设定提供时代常识。

输出必须是严格的 JSON（除 JSON 外不要输出任何文字），字段如下：
{
  "era": "时代定位标签：以开局年份为起点的人类可读描述（如 '2000 年代起的现代都市'）。不是时间范围——故事从开局年份起按时间线向前推进，可远超 20 年，具体形态看 evolution 时间轴",
  "story_start_year": 2000,
  "industry": "判定行业（如 人才中介/职业介绍）",
  "organization_forms": ["机构典型形态1（真实样子，如：临街一楼门面、黑板招工栏、登记册、一部电话）"],
  "boss_portrait": "老板/负责人画像（年龄段、出身、性格、忌讳……一句话以内）",
  "business_list": ["该年代该行业的真实业务1"],
  "location_pattern": "门店/机构通常开在哪里、为什么",
  "evolution": ["行业阶段演进时间轴：每条带起止年份、从开局年份起向后排列（如：2000—2003 信息差红利；2004—2008 互联网冲击；2010—2015 …），必须覆盖剧情可能写到的未来年份，不设 20 年上限"],
  "era_mismatch_red_flags": ["该年代最不该出现的时代错位（写作红线，每条必须带时间前提，如：2003年前无智能手机/线上支付；2013年前无微信）"],
  "confidence": "high|medium|low",
  "note": "判定依据：从项目信息哪里判断出年代与行业",
  "scope_issues": [
    {
      "dim": "background_type",
      "current": "当前值（如 alternate）",
      "suggested": "建议值（如 realistic）",
      "issue": "问题描述（为什么认为错选/冲突）",
      "fix": "改法（如：改为 realistic，故事有明确现实年代参照）"
    }
  ]
}

铁律：
- 研究的是「该年代×行业的真实历史形态」，不是小说里的具体设定；小说已有明确设定时，小说设定 > 研究常识。
- era 和 industry 必须有据可依：从项目前提/题材/导入文档中出现的年份、时代词、行业词判断；
  判断不出年代或行业时，confidence 写 low，并把判断不出的部分写进 note，不要硬编。
- era 只是「时代定位标签」不是时间范围：以开局年份为起点描述所处的时代（如 '2000 年代起的现代都市'），
  **不要写成 '2000年—2010年' 这样的起止范围**；时间锚点是 story_start_year，剧情从这里按时间线向前推进。
- evolution 是「从开局年份向后的演进时间轴」：每条带起止年份按时间排列（如 '2000—2003 …' '2010—2015 …'），
  **必须覆盖到剧情可能写到的未来年份，不设 20 年上限**——续写超越开局年代十年、二十年时，
  各年份形态仍能按此轴对照（写到 2030 年也能找到 2030 年的行业形态）。
- story_start_year：故事开局年份 = 剧情起点的明确年份（如 2000），从素材里的年份/时间词推断；
  推断得出就填数字，**推断不出填 null** 并把"未判定出开局年份，需作者确认"写进 note（不要硬编）。
- organization_forms / business_list / evolution 要具体、符合那个年代那个行业的真实样貌，禁止用现代的
  通用表述（如"数字化""平台化""APP""小程序"）去套过去年代。
- era_mismatch_red_flags 列 3—6 条即可，是本年代最容易犯的写作错位。**必须按时间演进表述**：
  · 每条红线带明确时间前提（"某年前没有/某年之后才出现"），不能写成"全篇禁绝"；
  · 故事从开局年份向后跨越多年时，开局年代不该有的东西在它出现的年份之后是**应该有的**
    （如 2013 年后主角用微信是正常设定，不是红线），红线只拦"时间错位"（在出现年份之前用了它）；
  · 政策/术语只出现在其推行年份之后（如新高考3+1+2、平行志愿、知分填报、位次法、冲稳保、
    微信/公众号/直播/线上支付/短视频/APP 等，各按真实出现年份给时间前提）。
- 纯架空（background_type=pure_fantasy）或完全没有现实参照时，era/industry 输出空字符串，
  confidence=low，note 写"无现实年代/行业参照，本知识包不适用"。
- scope_issues：研究时对照输入里的「世界背景类型」和「题材」，核对两者与研究结论是否相符——
  · background_type 冲突：现实年代明显（有年份/时代词/真实机构）却选了 alternate/pure_fantasy；
    或研究结论与 current 冲突（如判断是现实题材但写纯架空）。
  · genres 错选/漏选：研究结论指向的题材（如年代都市/职场）在题材里没选、或题材选了明显不符的
    （如纯架空玄幻却写 2000 年现实行业）。漏选按「建议补充」列出。
  · 尚未选择（输入为（未选择）/（未填））：必须按素材推断并输出建议引导作者确认——
    dim=background_type 时 suggested 填推断类型（realistic/alternate/pure_fantasy 三选一），
    issue 写「尚未选择，已按素材推断，请作者确认」；dim=genres 时 suggested 填推断题材
    （如 都市、职场）。
  · 没问题就不输出（scope_issues 为空数组）；每条必须是可执行的建议，不要空话。
  是否更新由作者决定——你只负责指出问题与建议，不修改项目信息。
"""


class EraResearcherAgent(Agent[EraResearch]):
    task_type = "setting"
    temperature = 0.2
    mock_output = {
        "era": "2000 年代起的现代都市",
        "story_start_year": 2000,
        "industry": "人才中介/职业介绍",
        "organization_forms": [
            "临街一楼门面：一块招牌、墙上黑板写招工信息、一张桌子一本登记册、一部电话",
            "夫妻店或带一两个亲戚，全店 2—4 人",
        ],
        "boss_portrait": "40—50 岁下海（国企下岗/停薪留职/做过企业人事），能说会道，提防员工学会业务后单干",
        "business_list": [
            "职业介绍：向求职者收信息费/中介费",
            "招工代理：向企业按人头收介绍费",
            "组织现场招聘会卖摊位",
            "灰色地带：代办档案托管/代缴社保",
        ],
        "location_pattern": "火车站、长途客运站、劳务市场周边人流大的临街位置",
        "evolution": [
            "2000—2003 纯信息差红利，靠墙黑板报和电话接单",
            "2004—2008 互联网招聘上线冲击，传统职介转型劳务派遣与现场招聘会；劳动部门整顿黑中介",
            "2008—2010 金融危机后珠三角/长三角招工荒，劳务派遣大行其道",
            "2011—2015 线上招聘移动化，门店职介客流萎缩，向劳务外包/人事代理转型",
            "2016—2020 灵活用工平台兴起，传统门店职介式微，合规门槛提高",
        ],
        "era_mismatch_red_flags": [
            "2003 年前无智能手机/线上支付/APP，2009 年后手机可 3G 上网",
            "2013 年前无微信，不能用「微信」「公众号」「直播」「短视频」等移动互联网产物",
            "新高考3+1+2（2021 起）、平行志愿、知分填报、位次法、冲稳保 等只出现在其推行年份之后",
            "2000 年代无「高考志愿规划师」官方职业，最接近的是「招生咨询老师」",
            "2000 年代一对一咨询收费多为几十到几百元，天价咨询是网络时代产物",
        ],
        "confidence": "high",
        "note": "项目前提提到 2000 年开始打工、2010 年自主创业，行业词有「人才信息服务部」",
        "scope_issues": [
            {
                "dim": "genres",
                "current": "（未填）",
                "suggested": "都市、职场",
                "issue": "题材未填，但研究判定为 2000 年代现实职场故事",
                "fix": "补充题材：都市、职场",
            }
        ],
    }

    def __init__(self, db: Session):
        super().__init__(db)

    def build_context(self, novel_id: uuid.UUID, params: dict) -> ContextPack:
        novel = get_novel(self.db, novel_id)
        # 未选择背景类型时如实告知 AI「（未选择）」，让它按素材推断并产出建议，
        # 而不是兜底当成 realistic（那样 AI 永远不知道作者没选，不会引导确认）
        background_type = (novel.background_type if novel else None) or "（未选择）"
        user_content = (
            f"项目：《{novel.title if novel else novel_id}》\n"
            f"世界背景类型：{background_type}\n"
            f"题材：{('、'.join(novel.genres or []) if novel and novel.genres else '（未填）')}\n"
            f"项目前提：{novel.premise if novel and novel.premise else '（未填）'}\n\n"
            f"可参考素材（设定摘要/导入文档，未必有）：\n"
            f"{params.get('material', '')[:12000] or '（无）'}"
        )
        return ContextPack(
            novel_id=novel_id,
            agent="era_researcher",
            system_prompt=SYSTEM_PROMPT,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            meta={"params": params},
            temperature=self.temperature,
        )

    def parse_output(self, text: str) -> EraResearch:
        return EraResearch.model_validate_json(text.strip())
