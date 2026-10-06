"""SSE 流式路由：/api/stream/agents/{agent}/run。

生成任务已从请求生命周期解耦为后台任务（agent_tasks 表）：页面刷新 / 连接断开后
任务继续生成并落库，前端可通过 GET /{agent}/tasks 查询进行中任务并恢复状态。
"""
import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.agents.registry import AGENT_NAMES
from app.db.models import AgentTask, AuthorConfirm, Chapter, ChapterVersion, Novel, Outline
from app.db.session import SessionLocal, get_db
from app.schemas.agents import (
    AgentCommitRequest,
    AgentRunRequest,
    AuthorConfirmSubmitRequest,
)
from app.services.pipeline import (
    answer_author_confirm,
    commit_agent_output,
    dismiss_author_confirm as pipeline_dismiss_author_confirm,
    get_pending_confirms,
    reset_confirm_wait_extender,
    run_agent_stream,
    set_confirm_wait_extender,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stream/agents", tags=["stream"])

# 进行中任务的流式文字进度缓存（内存态，key=task_id）。
# 用途：页面刷新 / 切页后 SSE 连接已断开，前端轮询 tasks 接口时据此恢复已生成的文字，
# 避免刷新后生成过程弹窗只剩占位文字（刷新前已流出的内容也能看到，并随轮询继续滚动）。
PROGRESS: dict[str, dict[str, str]] = {}

# 后台任务绝对超时（秒）：LLM 请求已单独限时（LLM_REQUEST_TIMEOUT_SECONDS=900），
# 这里留足重试/校验/落库缓冲。防止任务永久 running（曾因 LLM 挂起卡死 20+ 分钟）。
# 注意：等作者确认的时间不计入该预算（见 _ConfirmAwareTimeout），否则确认等待会占用
# 生成预算导致「等满 15 分钟自动跳过后剩余预算不足，任务被超时终止、蓝图无数据」。
TASK_ABSOLUTE_TIMEOUT_SECONDS = 1800

# 僵尸任务判死阈值（秒）：running 任务每 HEARTBEAT_INTERVAL_SECONDS(30s) 心跳刷新 updated_at；
# 超过该阈值仍无心跳的 running 视为失联（进程中断/协程挂死/状态写失败），懒清理自动标 error 解锁并发位。
# 合法任务不可能超过此阈值无心跳，因此取值远小于任务超时，让僵尸能快速自动解锁，不依赖重启后端。
STALE_RUNNING_AFTER_SECONDS = 600


class _ConfirmAwareTimeout:
    """任务绝对超时，但「等作者确认」的时间不占用生成预算。

    asyncio.timeout 的 deadline 本身不可暂停，这里按需顺延：
    request_author_confirmation 在每次确认等待开始前调用 extend(等待上限+缓冲)，
    结束后按实际等待时长精确回退（见 pipeline.set_confirm_wait_extender），
    使 deadline 最终只推进「实际生成 + 实际等待」——确认等待相当于暂停了生成计时器。
    解决：era/预检确认等满 15 分钟自动跳过后，剩余预算不足以跑完预检+蓝图师，
    任务 20 分钟整被超时终止、blueprints 无数据落库。
    """

    def __init__(self, seconds: float):
        self._loop = asyncio.get_running_loop()
        self._base = self._loop.time()   # 超时时钟起点（与 asyncio.timeout 实际 deadline 相差 <1ms）
        self._budget = seconds           # 生成预算（秒）
        self._extended = 0.0             # 累计顺延（= 累计等待作者的时间）
        self.timeout = asyncio.timeout(seconds)  # 创建 CM，进入 async with 时以当时时刻计算 deadline

    @property
    def deadline(self) -> float:
        return self._base + self._budget + self._extended

    def extend(self, seconds: float) -> None:
        """把任务超时 deadline 顺延 seconds 秒（可为负 = 回退）。"""
        self._extended += seconds
        try:
            self.timeout.reschedule(self.deadline)
        except Exception:
            logger.exception("任务超时 deadline 顺延失败（%.1fs，已累计 %.1fs）", seconds, self._extended)


# ---------- 生成后自动评价（签约适配检查） ----------
# 已移除：评价模型成本高，评价只允许作者手动触发（「评价与优化」面板手动评价）。
# 依赖评价结果的数据（如优化/修订）也只在手动评价成功后才由前端发起，正文生成不再自动评价。
# 相关函数（_schedule_auto_reviews / _run_auto_review / _build_auto_review_params /
# _find_new_versions / _summarize_outline）已一并删除。


async def _run_memory_keeper(novel_id: uuid.UUID, params: dict, task_id: uuid.UUID) -> None:
    """编年生成后台任务：跑完 memory_keeper 并落库，最后标记任务 done/error。"""
    task_db = SessionLocal()
    try:
        async with asyncio.timeout(TASK_ABSOLUTE_TIMEOUT_SECONDS):
            async for _sse in run_agent_stream(task_db, "memory_keeper", novel_id, params, task_id=task_id):
                pass  # 无前端 SSE 消费者：事件只用来驱动生成，落库由 pipeline 完成
    except Exception as e:
        logger.exception("agent=memory_keeper task=%s 编年生成失败", task_id)
        _finish_task(task_db, task_id, status="error", error=str(e))
    else:
        _finish_task(task_db, task_id, status="done", msg=f"编年已更新到第{params.get('up_to_chapter')}章")
    finally:
        task_db.close()


def _schedule_memory_keeper(db: Session, novel_id: uuid.UUID, agent_name: str, params: dict) -> None:
    """novelist/reviser 落库成功后调用：每 N 章自动触发一次编年师（长期记忆刷新）。

    守卫：
    - 只对正文生成类角色触发（novelist/reviser），且当前章节数正好是 chronicle_generate_every 的倍数；
    - 该小说已有 memory_keeper 任务在跑则跳过（避免并发写同一份编年）。
    """
    if agent_name not in ("novelist", "reviser"):
        return
    from app.config import get_settings

    every = get_settings().chronicle_generate_every
    if not every or every <= 0:
        return
    chapter_no = params.get("chapter_no")
    if chapter_no is None or chapter_no % every != 0:
        return
    running = db.execute(
        select(AgentTask).where(
            AgentTask.novel_id == novel_id,
            AgentTask.agent == "memory_keeper",
            AgentTask.status == "running",
        )
    ).scalar_one_or_none()
    if running is not None:
        logger.info("novel_id=%s 已有编年任务运行中，跳过本次触发", novel_id)
        return
    mem_params = {"up_to_chapter": chapter_no}
    mem_task = AgentTask(novel_id=novel_id, agent="memory_keeper", params=mem_params)
    db.add(mem_task)
    db.commit()
    db.refresh(mem_task)
    asyncio.create_task(_run_memory_keeper(novel_id, mem_params, mem_task.id))
    logger.info("novel_id=%s 第%s章 生成完成，已自动排队编年师", novel_id, chapter_no)


async def _ensure_era_research(
    db: Session, novel_id: uuid.UUID, material: str = "", on_pending=None, on_stream=None, task_id: uuid.UUID | None = None
) -> dict:
    """生成蓝图前自动研究「年代×行业」，研究结论请作者确认后再应用。

    这是运行时按需研究（替代开发期内置知识包）：换一本年代/行业不同的小说，
    生成蓝图时会自动重新研究并落库到 novel.era_research，不依赖开发加包。
    失败不阻断蓝图生成（仅记日志，返回 research=False）；已存在研究 / 纯架空则直接跳过。

    确认机制（作者把控方向）：
    - 研究结论（含背景类型×题材校验 scope_issues）以确认弹窗形式交给作者定夺：
      apply=应用研究结论 / apply_fix=应用结论并按建议修正背景类型题材 / ignore=忽略保持现状；
    - 作者超时未答复 → 自动应用研究结论（与旧行为一致，不阻塞蓝图生成）；
    - 刷新/断线后弹窗由前端轮询 pending 确认恢复（on_pending 负责在线实时弹窗）。

    思考过程实时展示：on_stream 把子代理的 thinking_delta 转发给前端生成弹窗，
    让用户在等确认/等主生成时看到模型正在思考（而非长时间空白占位）。

    返回 {"research": bool 是否完成研究, "decision": str|None 作者选择}
    """
    from app.db.models import Novel
    from app.services.pipeline import commit_agent_output, request_author_confirmation

    novel = db.get(Novel, novel_id)
    if novel is None:
        return {"research": False, "decision": None}
    if novel.era_research:
        return {"research": False, "decision": None}  # 已有研究（自动生成的或作者手改的）→ 直接复用
    if (novel.background_type or "realistic") == "pure_fantasy":
        return {"research": False, "decision": None}  # 纯架空无现实年代/行业参照，研究无意义
    try:
        logger.info("novel_id=%s 蓝图生成前自动研究年代×行业（material=%s 字）", novel_id, len(material or ""))
        params = {"material": material}
        result: dict | None = None
        async for sse in run_agent_stream(db, "era_researcher", novel_id, params, dry_run=True):
            ev = _parse_sse_event(sse)
            if on_stream and ev and ev["name"] == "thinking_delta":
                on_stream(sse)  # 研究思考实时转发，生成弹窗里滚动展示
            if ev and ev["name"] == "stored" and (ev["data"].get("action") == "dry_run"):
                result = ev["data"].get("data") or {}
        if not result:
            return {"research": False, "decision": None}
    except Exception:
        logger.exception("novel_id=%s 时代行业研究失败（不阻断蓝图生成）", novel_id)
        return {"research": False, "decision": None}

    scope_issues = [i for i in (result.get("scope_issues") or []) if isinstance(i, dict)]
    era = str(result.get("era") or "未知年代").strip()  # 时代定位标签（非时间范围）
    industry = str(result.get("industry") or "未知行业").strip()

    async def _apply_decision(decision: str) -> None:
        """按作者选择落库/修正。"""
        try:
            if decision == "apply":
                await commit_agent_output(db, "era_researcher", novel_id, params, result)
            elif decision == "apply_fix":
                novel2 = db.get(Novel, novel_id)
                if novel2 is not None:
                    for issue in scope_issues:
                        dim = issue.get("dim")
                        suggested = str(issue.get("suggested") or "").strip()
                        if dim == "background_type" and suggested in ("realistic", "alternate", "pure_fantasy"):
                            novel2.background_type = suggested
                        elif dim == "genres" and suggested:
                            # 必须整体赋新列表：genres 是裸 JSON 列（无 MutableList 变更追踪），
                            # 直接 .append() 原地修改不会把字段标记为 dirty，flush 时更新被丢弃。
                            new_genres = list(novel2.genres or [])
                            for g in re.split(r"[、,，;；]", suggested):
                                g = g.strip()
                                if g and g not in new_genres:
                                    new_genres.append(g)
                            novel2.genres = new_genres
                            # AI 新增的题材直接正式登记进题材字典库（作者后续所有书都能复用；升级不丢）
                            from app.api.meta import _upsert_custom_items

                            _upsert_custom_items("genre_presets", new_genres, db)
                    novel2.era_research = result
                    db.commit()
            # ignore：不落库研究，保持现有设定
        except Exception:
            logger.exception("novel_id=%s 时代研究按作者选择应用失败（不影响蓝图生成）", novel_id)

    # 有确认点才弹窗：有背景×题材问题时必须请作者定夺；没问题也请作者确认研究结论
    # （机构/老板/业务形态是"机构内容"，AI 默认产出不一定符合作者需求，作者把控）
    if on_pending is not None:
        try:
            # 作者未选择背景类型/题材时，研究结论里已含推断建议，文案里点明引导确认
            btype_missing = not novel.background_type
            genres_missing = not (novel.genres or [])
            if btype_missing and genres_missing:
                pick_hint = "你还没选背景类型和题材，系统按素材帮你猜了，请看下面的选项确认。"
            elif btype_missing:
                pick_hint = "你还没选背景类型，系统按素材帮你猜了，请看下面的选项确认。"
            elif genres_missing:
                pick_hint = "你还没选题材，系统按素材帮你猜了，请看下面的选项确认。"
            else:
                pick_hint = ""
            sy = result.get("story_start_year")
            if sy:
                sy_text = (
                    f"故事开局年份：{sy}（从素材推断）。剧情会按时间线推进、逐年对照当时真实情况；"
                    "如果年份不对，可以直接在下方输入框改（比如改成 2000）。"
                )
            else:
                sy_text = (
                    "没能从素材看出故事是哪一年开局的。请直接在下方输入框填一个开局年份（比如 2000），"
                    "剧情会按时间线推进、逐年对照当时真实情况。"
                )
            # 主表述以开局年份+行业为准（时代定位仅是标签，非时间范围）
            if sy:
                verdict = f"{sy} 年开局 · {industry}" + (f"（时代定位：{era}）" if era and era != "未知年代" else "")
            else:
                verdict = f"《{era} · {industry}》"
            decision = await request_author_confirmation(
                db,
                novel_id=novel_id,
                task_id=task_id,  # 透传主任务 id：确认等待期间保持心跳，防懒清理误杀
                agent="era_researcher",
                confirm_key="era_research_confirm",
                question=(
                    f"时代研究做完了，判定为「{verdict}」。\n{sy_text}\n" + pick_hint
                    + ("另外，系统觉得你选的背景类型或题材跟这个故事可能对不上，详见第二个选项。" if scope_issues else "")
                    + "\n下面的选项选一个就行；如果机构、老板、业务形态你有自己的想法，也可以在下方输入框直接写出来。"
                ),
                options=[
                    {"id": "apply", "label": "好，就用这个时代背景", "desc": "系统会记住故事发生在哪一年、干的是什么行业，之后写设定、写正文、做评价都按这个时代来。以后想改也能在项目设置里改。"},
                    {"id": "apply_fix", "label": "好，顺便把背景类型/题材改对", "desc": "系统觉得你选的背景类型或题材和故事不太搭，会自动帮你改成更合适的，同时也会记住时代背景。注意：你之前自己选的设定可能被改动。"},
                    {"id": "ignore", "label": "不用，按我自己填的来", "desc": "这次研究结果不用，系统按你原来自己选的背景直接开始，不会做任何修改。"},
                ],
                allow_custom=True,
                on_pending=on_pending,
            )
        except Exception:
            logger.exception("novel_id=%s 时代研究确认流程异常，自动应用研究结论", novel_id)
            decision = {"status": "timeout", "answer": None}
        if decision.get("status") == "answered" and decision.get("answer") in ("apply", "apply_fix"):
            await _apply_decision(decision["answer"])
            return {"research": True, "decision": decision["answer"]}
        if decision.get("status") == "answered" and decision.get("answer") == "ignore":
            return {"research": False, "decision": "ignore"}
        # 作者自定义输入（如直接在输入框填年份）：提取年份覆盖研究结论，按「应用」落库
        if decision.get("status") == "answered" and decision.get("answer") not in (None, "apply", "apply_fix", "ignore"):
            m = re.search(r"(?<!\d)((?:19|20)\d{2})(?!\d)", str(decision["answer"]))
            if m:
                result["story_start_year"] = int(m.group(1))
            await _apply_decision("apply")
            return {"research": True, "decision": "apply"}
        # dismissed / timeout：自动应用（旧行为，不阻塞蓝图生成）
        await _apply_decision("apply")
        return {"research": True, "decision": None}

    # 无弹窗通道（理论不出现，兜底）：直接应用研究结论
    await _apply_decision("apply")
    return {"research": True, "decision": None}


# 导入质检最多逐条问询的疑点数：超过的按 AI 建议处理（避免弹窗轰炸）
_BLUEPRINT_ISSUE_ASK_LIMIT = 5


def _blueprint_issue_options(issue: dict, suggestion: str) -> list[dict]:
    """组装单条疑点的处理选项：优先按质检师给出的 options id 清单展示，
    未指定（或 id 非法）时默认给全三个。选项按疑点情况可多可少，避免无关选项干扰作者判断。"""
    candidates = [
        {"id": "apply", "label": "按建议处理", "desc": suggestion or "以 AI 建议为准修正蓝图"},
        {"id": "keep", "label": "保持原文", "desc": "保留文档原样，不修正"},
        {"id": "delegate", "label": "交由蓝图师自行把握", "desc": "保留疑点与 AI 建议，由蓝图师结合整体自行决定"},
    ]
    ids = [str(i) for i in (issue.get("options") or []) if str(i) in {"apply", "keep", "delegate"}]
    if not ids:
        return candidates
    by_id = {o["id"]: o for o in candidates}
    return [by_id[i] for i in ids]


async def _ensure_blueprint_issues(
    db: Session,
    novel_id: uuid.UUID,
    params: dict,
    task_id: uuid.UUID,
    on_pending=None,
    on_stream=None,
) -> list[dict] | None:
    """蓝图导入前置：质检师通读导入文档，找出「模糊没写清 / 前后矛盾」疑点，
    逐条弹窗问作者怎么处理，答复注入蓝图师正式生成。

    - 仅导入模式（import_source 非空）触发；无弹窗通道 / 预检失败 / 无疑点 → 返回 None（不打断生成）；
    - 每条疑点一个 author_confirm 弹窗：
      - vague/conflict/missing/compliance：按建议处理 / 保持原文 / 交由蓝图师自行把握，具体给哪几项由质检师按疑点情况决定（能删就删；可另输入自定义处理意见；compliance 也可按建议修改后注入蓝图师）；
      - quality：继续生成 / 取消生成（作者选取消 → cancelled=True，中止蓝图生成）；
    - 疑点超过 _BLUEPRINT_ISSUE_ASK_LIMIT 条时只逐条问前 N 条，其余按 AI 建议处理；
    - 作者忽略/超时：该条按「保持原文」处理。
    返回 {"resolutions": [...], "cancelled": bool}；resolutions 供注入蓝图师
    （仅 vague/conflict/missing/compliance 逐条含 item/issue/source/suggestion/decision/decision_text，
    quality 为知情确认，不入注入）。
    """
    from app.services.pipeline import request_author_confirmation

    if on_pending is None:
        return None
    if not (params.get("import_source") or "").strip():
        return None  # 非导入模式不做质检
    result: dict | None = None
    try:
        async for sse in run_agent_stream(db, "blueprint_prechecker", novel_id, params, dry_run=True):
            ev = _parse_sse_event(sse)
            if on_stream and ev and ev["name"] == "thinking_delta":
                on_stream(sse)  # 质检思考实时转发，生成弹窗里滚动展示
            if ev and ev["name"] == "stored" and ev["data"].get("action") == "dry_run":
                result = ev["data"].get("data") or {}
    except Exception:
        logger.exception("novel_id=%s 蓝图导入质检预检失败（不阻断蓝图生成）", novel_id)
        return None
    issues = [i for i in (result.get("issues") or []) if isinstance(i, dict) and i.get("issue")]
    if not issues:
        return None  # 文档内部无疑点，直接生成

    resolutions: list[dict] = []
    for idx, issue in enumerate(issues[: _BLUEPRINT_ISSUE_ASK_LIMIT], 1):
        suggestion = str(issue.get("suggestion") or "").strip()
        qtype = issue.get("type")
        # quality：文档质量可疑（乱码/过短），作者知情确认（继续 / 取消），不产生蓝图处理意见
        if qtype == "quality":
            try:
                decision = await request_author_confirmation(
                    db,
                    novel_id=novel_id,
                    task_id=task_id,
                    agent="blueprint_prechecker",
                    confirm_key=f"blueprint_issue_{task_id}_{idx}",
                    question=(
                        f"蓝图导入提示 {idx}/{len(issues)}（{issue.get('item') or '整篇文档'}）："
                        f"{issue.get('issue') or ''}"
                        + (f"\n\n原文：「{issue.get('source')}」" if issue.get("source") else "")
                        + (f"\n建议：{suggestion}" if suggestion else "")
                        + "\n\n是否继续？"
                    ),
                    options=[
                        {"id": "continue", "label": "继续生成", "desc": "已知晓该情况，按当前文档继续生成蓝图"},
                        {"id": "cancel", "label": "取消生成", "desc": "停止本次蓝图生成，我先处理文档"},
                    ],
                    allow_custom=False,
                    on_pending=on_pending,
                )
            except Exception:
                logger.exception("novel_id=%s 蓝图质检确认流程异常（按继续处理）", novel_id)
                decision = {"status": "dismissed", "answer": None}
            option = decision.get("option") if decision.get("status") == "answered" else None
            if option and option.get("id") == "cancel":
                return {"resolutions": resolutions, "cancelled": True}
            continue  # continue/忽略/超时 → 不注入蓝图师
        try:
            decision = await request_author_confirmation(
                db,
                novel_id=novel_id,
                task_id=task_id,
                agent="blueprint_prechecker",
                confirm_key=f"blueprint_issue_{task_id}_{idx}",
                question=(
                    f"蓝图整理中发现疑点 {idx}/{len(issues)}（{issue.get('item') or '未指明对象'}）："
                    f"{issue.get('issue') or ''}"
                    + (f"\n\n原文：「{issue.get('source')}」" if issue.get("source") else "")
                    + (f"\n建议：{suggestion}" if suggestion else "")
                    + "\n\n要如何处理？"
                ),
                options=_blueprint_issue_options(issue, suggestion),
                allow_custom=True,
                on_pending=on_pending,
            )
        except Exception:
            logger.exception("novel_id=%s 蓝图疑点确认流程异常（该条按保持原文处理）", novel_id)
            decision = {"status": "dismissed", "answer": None}
        if decision.get("status") == "answered":
            option = decision.get("option")
            answer = decision.get("answer")
            if option:
                resolutions.append({**issue, "decision": option.get("id"), "decision_text": option.get("label")})
            elif answer and str(answer).strip():
                resolutions.append({**issue, "decision": "custom", "decision_text": str(answer).strip()})
            else:
                resolutions.append({**issue, "decision": "keep", "decision_text": "保持原文"})
        else:
            resolutions.append({**issue, "decision": "keep", "decision_text": "保持原文"})
    # 超出问询上限的疑点：按 AI 建议处理，不再打扰作者
    for issue in issues[_BLUEPRINT_ISSUE_ASK_LIMIT:]:
        if issue.get("type") == "quality":
            continue  # 超限的知情确认类不注入，也不打扰作者
        resolutions.append({**issue, "decision": "apply", "decision_text": issue.get("suggestion") or "按 AI 建议处理"})
    return {"resolutions": resolutions, "cancelled": False}


def _parse_sse_event(sse_text: str) -> dict | None:
    """解析一条 SSE 事件文本 → {"name", "data"}（无法解析返回 None）。"""
    name = ""
    data = ""
    for ln in sse_text.splitlines():
        if ln.startswith("event:"):
            name = ln[6:].strip()
        elif ln.startswith("data:"):
            data = ln[5:].strip()
    if not name or not data:
        return None
    try:
        return {"name": name, "data": json.loads(data)}
    except Exception:
        return None


async def _propose_outline_direction(
    db: Session,
    novel_id: uuid.UUID,
    params: dict,
    task_id: uuid.UUID,
    on_pending=None,
    on_stream=None,
) -> dict | None:
    """大纲生成前置：方向提案师产出 3 个候选 → 作者确认（或自定义输入）→ 返回注入参数。

    作者确认后返回 {"label","desc","note"}（注入 outliner 的 author_direction）；
    作者忽略/超时/提案失败返回 None（大纲师自行把握方向，不阻断生成）。
    confirm_key 带 task_id：每次生成任务独立咨询（作者换方向重生成时会重新咨询）。
    """
    from app.services.pipeline import request_author_confirmation

    chapter_no = params.get("chapter_no")
    proposal: dict | None = None
    try:
        async for sse in run_agent_stream(db, "direction_proposer", novel_id, params, dry_run=True):
            ev = _parse_sse_event(sse)
            if on_stream and ev and ev["name"] == "thinking_delta":
                on_stream(sse)  # 提案思考实时转发，生成弹窗里滚动展示
            if ev and ev["name"] == "stored" and ev["data"].get("action") == "dry_run":
                proposal = ev["data"].get("data") or {}
    except Exception:
        logger.exception("novel_id=%s 大纲方向提案生成失败（不阻断大纲生成）", novel_id)
        return None
    if not proposal:
        return None
    directions = [
        d for d in (proposal.get("directions") or [])
        if isinstance(d, dict) and d.get("id") and d.get("label")
    ]
    if len(directions) < 3:
        logger.warning("novel_id=%s 大纲方向提案不足 3 个（%s），跳过咨询", novel_id, len(directions))
        return None
    if on_pending is None:
        return None  # 无弹窗通道则跳过咨询（理论不出现，兜底）

    try:
        decision = await request_author_confirmation(
            db,
            novel_id=novel_id,
            task_id=task_id,
            agent="outliner",
            confirm_key=f"outline_direction_{task_id}",
            question=(
                f"即将生成第 {chapter_no} 章大纲。蓝图只是大方向，下一步故事往哪走由你定夺"
                "（可选一个方向，或自己输入一个）："
            ),
            options=directions,
            allow_custom=True,
            on_pending=on_pending,
        )
    except Exception:
        logger.exception("novel_id=%s 大纲方向确认流程异常（不阻断大纲生成）", novel_id)
        return None
    if decision.get("status") != "answered":
        return None  # dismissed / timeout：大纲师自行把握
    answer = decision.get("answer")
    option = decision.get("option")
    note = (decision.get("note") or "").strip()
    if option:
        return {"label": option.get("label"), "desc": option.get("desc") or "", "note": note}
    if answer:
        return {"label": answer, "desc": "", "note": note}
    return None


def _plan_to_outline_text(plan: dict) -> str:
    """把作者确认的「本章规划」压成大纲文本，注入 novelist 的【本章大纲】组件。

    规划字段（title/goal/chapter_function/pov/beats/ending_hook + 写法要点）与 novelist
    读取的大纲结构一致：chapter_function 派生 L3 节奏、goal 注入【本章目标】、节拍给正文
    骨架。写法要点是作者定向——novelist 必须照此演，不自由发挥。
    """
    parts = [
        f"标题：{plan.get('title') or ''}",
        f"目标：{plan.get('goal') or ''}",
        f"节奏功能：{plan.get('chapter_function') or 'progression'}",
        f"视角：{plan.get('pov') or ''}",
    ]
    if plan.get("time_slice"):
        parts.append(f"时间切片：{plan['time_slice']}")
    if plan.get("narrative"):
        parts.append(f"叙事方案：{plan['narrative']}")
    if plan.get("pace"):
        parts.append(f"节奏/开场：{plan['pace']}")
    beats = [b for b in (plan.get("beats") or []) if isinstance(b, str) and b.strip()]
    if beats:
        parts.append(f"节拍：{'；'.join(beats)}")
    if plan.get("execution"):
        parts.append(f"执行收尾：{plan['execution']}")
    if plan.get("ending_hook"):
        parts.append(f"结尾钩子：{plan.get('ending_hook')}")
    wt = []
    if plan.get("entry"):
        wt.append(f"进入/触发：{plan['entry']}")
    if plan.get("tone"):
        wt.append(f"风格基调：{plan['tone']}")
    if plan.get("protagonist_arc"):
        wt.append(f"主角反应弧：{plan['protagonist_arc']}")
    if plan.get("core_conflict"):
        wt.append(f"核心冲突：{plan['core_conflict']}")
    if plan.get("satisfaction"):
        wt.append(f"爽点类型：{plan['satisfaction']}")
    if wt:
        parts.append("写法要点（作者定向，不得替换演法）：" + "；".join(wt))
    return "\n".join(p for p in parts if p)


async def _propose_chapter_plan(
    db: Session,
    novel_id: uuid.UUID,
    params: dict,
    task_id: uuid.UUID,
    on_pending=None,
    on_stream=None,
) -> dict | None:
    """正文生成前置：逐维度咨询作者「本章规划」（大纲+章节合并方案）。

    章节规划师把本章规划拆成 3 个维度（核心事件/叙事方案/执行收尾）。**一次只生成一个维度**的
    3 个固定不重复候选选项（+ 前端 1 个自定义输入），作者选定/输入后，把前面的选择作为上下文
    再生成下一个维度，共 3 轮。作者任一轮跳过/超时 → 中断咨询返回 None（novelist 按既有方式
    续写，不阻断）。全部定完后组合成完整 plan dict（title/goal/chapter_function/pov/beats/
    ending_hook + 写法要点），由调用方落库为 approved 大纲（轻量版）并注入 novelist 参数据此
    写正文。confirm_key 带 task_id + 维度 key：每次生成任务独立咨询（换方向重生成时会重新咨询）。
    """
    from app.agents.chapter_planner import (
        PLAN_DIMENSIONS,
        dimension_compliance_check,
        fallback_repair_options,
        goal_extra_check,
        options_overlap,
    )
    from app.agents.context import get_active_blueprint
    from app.services.pipeline import request_author_confirmation

    # 章节号先确定：planner 上下文（时间线/阶段）与落库（persist_chapter_plan）都要用
    chapter_no = params.get("chapter_no")
    if chapter_no is None:
        last = db.execute(
            select(func.max(Chapter.chapter_no)).where(Chapter.novel_id == novel_id)
        ).scalar()
        chapter_no = (last or 0) + 1
        params["chapter_no"] = chapter_no

    # goal 维度金手指锚定/强打脸拦截所需的蓝图上下文：仅开篇章（第 1 章）生效
    goal_blueprint = get_active_blueprint(db, novel_id)
    if not isinstance(goal_blueprint, dict):
        goal_blueprint = None

    if on_pending is None:
        return None  # 无弹窗通道则跳过咨询（理论不出现，兜底）

    # 执行方案骨架（与 _plan_to_outline_text / persist_chapter_plan 读取的 key 一致）
    # 三维度（核心事件/叙事方案/执行收尾）选中后，各自的结构化字段映射回下面的 key：
    #   goal → time_slice/core_conflict/protagonist_arc
    #   narrative → pace/chapter_function/pov/tone/entry
    #   execution → beats/ending_hook/satisfaction
    plan: dict = {
        "label": "",
        "title": "",
        "goal": "",
        "time_slice": "",
        "narrative": "",
        "pace": "",
        "chapter_function": "progression",
        "pov": "",
        "execution": "",
        "beats": [],
        "ending_hook": "",
        "entry": "",
        "tone": "",
        "protagonist_arc": "",
        "core_conflict": "",
        "satisfaction": "",
    }
    selections: dict[str, str] = {}  # 维度key → 取值（选项 text 或作者自定义文本）
    note = ""

    for idx, dim in enumerate(PLAN_DIMENSIONS):
        key = dim["key"]
        # 1) 生成当前维度的候选选项：带上前面已定维度（plan_selections）作为上下文
        params["plan_dimension_key"] = key
        params["plan_selections"] = dict(selections)
        proposal: dict | None = None
        try:
            async for sse in run_agent_stream(db, "chapter_planner", novel_id, params, dry_run=True):
                ev = _parse_sse_event(sse)
                if on_stream and ev and ev["name"] == "thinking_delta":
                    on_stream(sse)  # 规划思考实时转发，生成弹窗里滚动展示
                if ev and ev["name"] == "stored" and ev["data"].get("action") == "dry_run":
                    proposal = ev["data"].get("data") or {}
        except Exception:
            logger.exception(
                "novel_id=%s 第 %s 个维度（%s）提案生成失败，中断逐维度咨询（不阻断正文生成）",
                novel_id, idx + 1, key,
            )
            return None
        if not proposal:
            logger.warning(
                "novel_id=%s 第 %s 个维度（%s）提案为空（LLM 未产出或校验未通过），中断逐维度咨询（不阻断正文生成）",
                novel_id, idx + 1, key,
            )
            return None
        dim_data = proposal.get("dimension") or {}
        options = [
            o for o in (dim_data.get("options") or [])
            if isinstance(o, dict) and o.get("id") and str(o.get("text", "")).strip()
        ]
        if len(options) != 3:
            logger.warning(
                "novel_id=%s 第 %s 个维度（%s）候选数不是 3（%s），中断逐维度咨询",
                novel_id, idx + 1, key, len(options),
            )
            return None

        # 2.5) 候选质量校验 + 自动修复链：①同一维度内雷同（同一桥段换措辞凑数）②内容偏离维度定义
        # （如把具体事件/系统激活塞进 pace 节奏描述，跨层混搭/字段缺失）③goal 开篇金手指锚定/
        # 同一时间切片/弱小时期强打脸拦截。最多自动修复 3 次（第 2 次=换一批重试，第 3 次=定向修复），
        # 仍不合规则降级兜底（补全字段+打标记，提示作者可自定义）——绝不把不合规候选静默推给作者。
        fallback_used = False
        for _attempt in range(1, 4):
            overlap = options_overlap(options, key=key)
            compliance = dimension_compliance_check(key, options, prev_goal=str(selections.get("goal") or ""))
            extra = goal_extra_check(goal_blueprint, chapter_no, options) if key == "goal" else None
            reason = extra or compliance or overlap
            if not reason:
                break  # 合规，使用当前 options
            if _attempt >= 3:
                options = fallback_repair_options(key, options, [reason])
                fallback_used = True
                logger.warning(
                    "novel_id=%s 第 %s 个维度（%s）连续 3 次生成不合规（%s），已降级兜底（补全字段+标记）供作者参考",
                    novel_id, idx + 1, key, reason,
                )
                break
            logger.warning(
                "novel_id=%s 第 %s 个维度（%s）候选不合规：%s，自动%s",
                novel_id, idx + 1, key, reason,
                "定向修复" if _attempt == 2 else "重试一次",
            )
            params["_dim_retry"] = {"key": key, "reason": reason, "repair": _attempt == 2}
            try:
                async for sse in run_agent_stream(db, "chapter_planner", novel_id, params, dry_run=True):
                    ev = _parse_sse_event(sse)
                    if on_stream and ev and ev["name"] == "thinking_delta":
                        on_stream(sse)
                    if ev and ev["name"] == "stored" and ev["data"].get("action") == "dry_run":
                        proposal = ev["data"].get("data") or {}
            except Exception:
                logger.exception(
                    "novel_id=%s 第 %s 个维度（%s）%s失败，沿用上一轮选项",
                    novel_id, idx + 1, key, "定向修复" if _attempt == 2 else "重试",
                )
                proposal = None
            finally:
                params.pop("_dim_retry", None)
            if not proposal:
                options = fallback_repair_options(key, options, [reason])
                fallback_used = True
                break
            dim_data = proposal.get("dimension") or {}
            retry_options = [
                o for o in (dim_data.get("options") or [])
                if isinstance(o, dict) and o.get("id") and str(o.get("text", "")).strip()
            ]
            if len(retry_options) != 3:
                logger.warning(
                    "novel_id=%s 第 %s 个维度（%s）重试候选数不是 3（%s），沿用上一轮选项",
                    novel_id, idx + 1, key, len(retry_options),
                )
                options = fallback_repair_options(key, options, [reason])
                fallback_used = True
                break
            options = retry_options

        # 3) 请作者在当前维度选择或自定义
        done_lines = [
            f"{d['label']}={selections[d['key']]}"
            for d in PLAN_DIMENSIONS[:idx]
            if d["key"] in selections and selections[d["key"]]
        ]
        prev_txt = "；".join(done_lines) if done_lines else "（无，这是本章第一个维度）"
        # goal 维度把候选声明的时间切片展示给作者（作者可据此判断是否锚定一致/是否想换切片）
        slice_note = ""
        if key == "goal":
            sl = [str(o.get("time_slice") or "").strip() for o in options]
            sl = [s for s in sl if s]
            if sl:
                uniq = sorted(set(sl))
                slice_note = (
                    f"。3 个候选锚定时间切片：{' / '.join(uniq)}（可选一致，也可在自定义框改切片）"
                    if len(uniq) == 1
                    else f"。注意：候选声明了不同时间切片：{' / '.join(uniq)}，请按同一切片比较"
                )
        fallback_note = ""
        if fallback_used:
            fallback_note = "（注意：AI 连续多次未能生成合规候选，以下选项为系统兜底补全，建议优先在自定义框输入你的方向）"
        try:
            decision = await request_author_confirmation(
                db,
                novel_id=novel_id,
                task_id=task_id,
                agent="novelist",
                confirm_key=f"chapter_plan_{task_id}_{key}",
                question=(
                    f"即将写作第 {chapter_no} 章正文。第 {idx + 1}/{len(PLAN_DIMENSIONS)} 维度「{dim['label']}」"
                    f"——{dim['hint']}。{slice_note}{fallback_note}\n"
                    f"前序已定：{prev_txt}。\n"
                    f"选一个方向，或输入你自己的："
                ),
                options=options,
                allow_custom=True,
                on_pending=on_pending,
            )
        except Exception:
            logger.exception("novel_id=%s 本章规划第 %s 维度确认流程异常（不阻断正文生成）", novel_id, idx + 1)
            return None
        if decision.get("status") != "answered":
            # 作者跳过/超时当前维度：不再继续咨询后续维度。
            # 但已确认过的维度必须保留（不能整体 return None 丢弃）——否则用户前面
            # 确认的核心事件被白白浪费，novelist 无约束自由写，正文与已定方案冲突。
            if selections:
                logger.warning(
                    "novel_id=%s 第 %s 个维度（%s）作者跳过/超时，保留已确认维度（%s）继续生成",
                    novel_id, idx + 1, key, "、".join(selections),
                )
                break
            return None  # 一个维度都没确认：无任何作者约束，novelist 按既有方式续写
        answer = decision.get("answer")
        if not answer:
            return None
        if (decision.get("note") or "").strip():
            note = decision["note"].strip()

        # 3) 取值并入执行方案：命中选项取其 text + 结构化信息；未命中（自定义）用作者原文
        opt = next((o for o in options if o["id"] == answer), None)
        if opt:
            value = opt["text"]
            if key == "goal":
                if opt.get("time_slice"):
                    plan["time_slice"] = str(opt["time_slice"]).strip()
                if opt.get("core_conflict"):
                    plan["core_conflict"] = str(opt["core_conflict"]).strip()
                if opt.get("protagonist_arc"):
                    plan["protagonist_arc"] = str(opt["protagonist_arc"]).strip()
            if key == "narrative":
                plan["narrative"] = value
                if opt.get("chapter_function"):
                    plan["chapter_function"] = opt["chapter_function"]
                if opt.get("pace"):
                    plan["pace"] = str(opt["pace"]).strip()
                if opt.get("pov"):
                    plan["pov"] = str(opt["pov"]).strip()
                if opt.get("tone"):
                    plan["tone"] = str(opt["tone"]).strip()
                if opt.get("entry"):
                    plan["entry"] = str(opt["entry"]).strip()
            if key == "execution":
                plan["execution"] = value
                if opt.get("beats"):
                    plan["beats"] = [b for b in opt["beats"] if isinstance(b, str) and b.strip()]
                if opt.get("ending_hook"):
                    plan["ending_hook"] = str(opt["ending_hook"]).strip()
                if opt.get("satisfaction"):
                    plan["satisfaction"] = str(opt["satisfaction"]).strip()
        else:
            value = answer
        plan[key] = value
        selections[key] = value

    if note:
        plan["note"] = note
    return plan


async def _propose_scene_plan(
    db: Session,
    novel_id: uuid.UUID,
    params: dict,
    task_id: uuid.UUID,
    plan: dict,
    on_pending=None,
    on_stream=None,
) -> list[dict] | None:
    """正文生成前置（第 2 阶段）：本章规划定稿后，把本章拆成 3-5 个场景逐字段确认。

    场景规划师基于作者已确认的本章规划（params["chapter_plan"]）+ 同一套素材，
    一次生成 3-5 个场景的骨架（每场景五字段：地点/出场人物/目标/冲突/结果，每字段恰好
    5 个固定不重复候选 + 前端 1 个自定义）。作者在「场景卡片」内逐字段单选/自定义，
    一张卡一个场景；全部场景确认后，再对每个场景生成 5 个约 100 字的写法提案，
    作者六选一（5 提案 + 自定义，或「都不满意，重新生成」）。最终拼成场景执行清单
    [{scene_index, location, participants, goal, conflict, outcome, proposal}]，
    注入 params["scene_plan"] 供 novelist 作为硬约束写作。

    作者在任一确认点跳过/超时 → 中断场景规划返回 None（novelist 按本章规划方案续写，不阻断）。
    """
    from app.agents.scene_planner import SCENE_FIELDS
    from app.services.pipeline import request_author_confirmation

    chapter_no = params.get("chapter_no")
    if on_pending is None:
        return None  # 无弹窗通道则跳过场景规划（兜底）

    # ---- 阶段 1：生成 3-5 个场景骨架（一次产出全部场景，每字段 5 候选） ----
    params["scene_task"] = "plan"
    params["chapter_plan"] = plan
    proposal: dict | None = None
    try:
        async for sse in run_agent_stream(db, "scene_planner", novel_id, params, dry_run=True):
            ev = _parse_sse_event(sse)
            if on_stream and ev and ev["name"] == "thinking_delta":
                on_stream(sse)  # 场景规划思考实时转发
            if ev and ev["name"] == "stored" and ev["data"].get("action") == "dry_run":
                versions = ev["data"].get("versions") or []
                if versions and versions[0].get("data"):
                    proposal = versions[0]["data"] or {}
    except Exception:
        logger.exception("novel_id=%s 场景骨架生成失败，中断场景规划（不阻断正文生成）", novel_id)
        return None
    if not proposal:
        return None

    # 规范化：按 scene_index 排序、按 SCENE_FIELDS 固定顺序重排字段、校验每字段恰 5 选项
    scenes: list[dict] = []
    for s in proposal.get("scenes") or []:
        raw_fields = {
            (f.get("field") or ""): f
            for f in (s.get("fields") or [])
            if isinstance(f, dict) and f.get("field")
        }
        field_payloads: list[dict] = []
        ok = True
        for spec in SCENE_FIELDS:
            f = raw_fields.get(spec["field"])
            if not f:
                ok = False
                break
            options = [
                o for o in (f.get("options") or [])
                if isinstance(o, dict) and o.get("id") and str(o.get("text", "")).strip()
            ]
            if len(options) != 5:
                ok = False
                break
            field_payloads.append({
                "field": spec["field"],
                "label": spec["label"],
                "hint": spec["hint"],
                "options": options,
            })
        if not ok:
            logger.warning("novel_id=%s 场景骨架字段/选项数异常，中断场景规划", novel_id)
            return None
        scenes.append({
            "scene_index": int(s.get("scene_index") or 0),
            "fields": field_payloads,
        })
    scenes.sort(key=lambda x: x["scene_index"])
    for i, sc in enumerate(scenes):
        sc["scene_index"] = i + 1  # 重排为 1..N，与确认顺序一致
    if not (3 <= len(scenes) <= 5):
        logger.warning("novel_id=%s 场景数不是 3-5（%s），中断场景规划", novel_id, len(scenes))
        return None

    # ---- 阶段 2：逐场景卡片确认（每张卡 = 一个场景的五字段，逐字段单选/自定义） ----
    scene_candidates: list[dict] = []
    for i, sc in enumerate(scenes):
        fields_payload = sc["fields"]
        try:
            decision = await request_author_confirmation(
                db,
                novel_id=novel_id,
                task_id=task_id,
                agent="scene_planner",
                confirm_key=f"scene_plan_{task_id}_{i}",
                question=(
                    f"第 {chapter_no} 章 · 场景 {i + 1}/{len(scenes)}。"
                    f"下面五个要素各给 5 个候选，逐项选择或输入你自己的；全部确认后进入下一张卡片。\n"
                    f"（作者已确认的本章规划会作为上下文生成这些候选）"
                ),
                fields=fields_payload,
                allow_custom=True,
                on_pending=on_pending,
            )
        except Exception:
            logger.exception("novel_id=%s 场景 %s 卡片确认流程异常（中断场景规划）", novel_id, i + 1)
            return None
        if decision.get("status") != "answered":
            return None  # 作者跳过/超时：放弃场景规划
        field_answers = decision.get("fields") or {}
        if not isinstance(field_answers, dict):
            return None
        cand: dict = {"scene_index": i + 1}
        for spec in SCENE_FIELDS:
            val = str(field_answers.get(spec["field"]) or "").strip()
            if not val:
                logger.warning("novel_id=%s 场景 %s 字段「%s」未填写，中断场景规划", novel_id, i + 1, spec["label"])
                return None
            cand[spec["field"]] = val
        scene_candidates.append(cand)

    # ---- 阶段 3：逐场景写法提案确认（5 提案 + 自定义，六选一；可重新生成） ----
    scene_plan: list[dict] = []
    for i, cand in enumerate(scene_candidates):
        params["scene_task"] = "proposal"
        params["scene_index"] = i + 1
        params["scene_candidate"] = cand
        selected: str = ""
        for round_no in range(3):  # 「重新生成」最多 3 轮，防死循环
            prop_out: list[dict] = []
            try:
                async for sse in run_agent_stream(db, "scene_planner", novel_id, params, dry_run=True):
                    ev = _parse_sse_event(sse)
                    if on_stream and ev and ev["name"] == "thinking_delta":
                        on_stream(sse)
                    if ev and ev["name"] == "stored" and ev["data"].get("action") == "dry_run":
                        versions = ev["data"].get("versions") or []
                        if versions and versions[0].get("data"):
                            pdata = versions[0]["data"] or {}
                            prop_out = [
                                o for o in (pdata.get("proposals") or [])
                                if isinstance(o, dict) and o.get("id") and str(o.get("text", "")).strip()
                            ]
            except Exception:
                logger.exception("novel_id=%s 场景 %s 写法提案生成失败（跳过提案）", novel_id, i + 1)
                break
            if len(prop_out) != 5:
                logger.warning("novel_id=%s 场景 %s 写法提案数不是 5（%s），跳过提案", novel_id, i + 1, len(prop_out))
                break
            try:
                decision = await request_author_confirmation(
                    db,
                    novel_id=novel_id,
                    task_id=task_id,
                    agent="scene_planner",
                    confirm_key=f"scene_proposal_{task_id}_{i}_r{round_no}",
                    question=(
                        f"第 {chapter_no} 章 · 场景 {i + 1}/{len(scene_candidates)} 的写法提案。\n"
                        f"该场景：{cand['location']}｜{cand['participants']}｜目标={cand['goal']}｜"
                        f"冲突={cand['conflict']}｜结果={cand['outcome']}\n"
                        f"5 个提案是 5 种不同的写法（约 100 字梗概），选一个；都不满意可输入自己的，或选「重新生成」。"
                    ),
                    options=prop_out,
                    regenerable=True,
                    allow_custom=True,
                    on_pending=on_pending,
                )
            except Exception:
                logger.exception("novel_id=%s 场景 %s 写法提案确认异常（跳过提案）", novel_id, i + 1)
                break
            if decision.get("status") != "answered":
                break  # 作者跳过/超时：该场景无提案，场景清单保留
            if decision.get("regenerate"):
                continue  # 重新生成提案再弹
            answer = decision.get("answer")
            if not answer:
                break
            opt = next((o for o in prop_out if o["id"] == answer), None)
            selected = opt["text"] if opt else answer
            break
        scene_plan.append({**cand, "proposal": selected})

    return scene_plan


def _iso_utc(dt) -> str | None:
    """数据库 DateTime 由 SQLite CURRENT_TIMESTAMP 写入，为 UTC 且无时区标记；
    序列化时补 Z，前端 new Date() 才能按正确时区解析（否则会按本地时区解析，偏差 8 小时）。"""
    return dt.isoformat() + "Z" if dt else None


def _update_progress(task_id: uuid.UUID, sse_text: str) -> None:
    """从 SSE 事件文本中提取 thinking_delta / stream_delta，累积到 PROGRESS 缓存。"""
    name = ""
    data = ""
    for ln in sse_text.splitlines():
        if ln.startswith("event:"):
            name = ln[6:].strip()
        elif ln.startswith("data:"):
            data = ln[5:].strip()
    if name not in ("thinking_delta", "stream_delta") or not data:
        return
    try:
        import json

        delta = (json.loads(data).get("delta") or "") if data else ""
    except Exception:
        return
    if not delta:
        return
    key = "thinking" if name == "thinking_delta" else "draft"
    cur = PROGRESS.get(str(task_id), {"thinking": "", "draft": ""})
    cur[key] = cur.get(key, "") + delta
    PROGRESS[str(task_id)] = cur


def _sweep_stale_tasks(db: Session, novel_id: uuid.UUID, agent: str | None = None) -> None:
    """懒清理：把「running 但长时间无心跳」的僵尸任务标 error，释放并发位。

    生产环境不能靠重启后端清僵尸（会中断所有用户的进行中任务）；改由请求路径顺带清扫：
    任务运行期间每 30s 心跳刷新 updated_at，超过 STALE_RUNNING_AFTER_SECONDS 无心跳即为失联。
    幂等 UPDATE，多 worker 下谁收到请求谁清理，天然安全。
    """
    q = select(AgentTask).where(
        AgentTask.novel_id == novel_id,
        AgentTask.status == "running",
    )
    if agent is not None:
        q = q.where(AgentTask.agent == agent)
    stale_until = datetime.utcnow() - timedelta(seconds=STALE_RUNNING_AFTER_SECONDS)
    rows = db.execute(q).scalars().all()
    cleaned = False
    for t in rows:
        last_active = t.updated_at or t.created_at
        if last_active is not None and last_active < stale_until:
            t.status = "error"
            t.error = "任务长时间无心跳（失联/进程中断），已自动清理，请重试。"
            logger.warning(
                "novel_id=%s agent=%s task=%s 僵尸任务自动清理（最后活跃 %s）",
                novel_id, t.agent, t.id, last_active,
            )
            cleaned = True
    if cleaned:
        db.commit()


def _finish_task(task_db: Session, task_id: uuid.UUID, *, status: str, msg: str | None = None, error: str | None = None) -> None:
    """后台任务结束时更新 agent_tasks 记录状态（供前端刷新后轮询）。

    done 时若任务已有 msg（如蓝图落库时写入的"蓝图 vX 已生成完毕…"），保留不覆盖；
    error 时始终写入错误信息。

    先 rollback 清掉当前事务：落库失败（如 JSON 序列化 TypeError）会让 session 进入
    PendingRollback 状态，此时不先回滚，下面的 get/commit 会再次抛 PendingRollbackError，
    导致任务状态永远停在 running（曾见 extractor 落库失败后任务一直 running、
    前端无完成提示、按钮高亮不灭、重试被 409 拒绝）。
    """
    try:
        task_db.rollback()
    except Exception:
        pass
    t = task_db.get(AgentTask, task_id)
    if t is None:
        return
    t.status = status
    if msg is not None and (status != "done" or not t.msg):
        t.msg = msg
    if error is not None:
        t.error = error
    elif status != "error":
        # 状态不再是 error：清掉残留的旧错误（如任务被懒清理误标 error 后又正常完成）
        t.error = None
    # 任务结束（无论成败）：作废该任务仍未答复的确认点。正常流程确认在任务结束前就已
    # answered/dismissed；残留 pending 说明确认等待被中断（进程重启/任务异常退出/懒清理误杀），
    # 再挂下去只会让「跨小说确认提醒」永远提醒一个已无意义的确认（任务都不在等了）。
    try:
        stale_confirms = task_db.execute(
            select(AuthorConfirm).where(
                AuthorConfirm.task_id == task_id,
                AuthorConfirm.status == "pending",
            )
        ).scalars().all()
        for pc in stale_confirms:
            pc.status = "dismissed"
            pc.answer = "__obsolete__"
            pc.answer_meta = {"label": None, "note": "任务已结束，确认点自动作废"}
    except Exception:
        task_db.rollback()
    task_db.commit()


@router.get("/status")
def stream_status(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """查询该小说最近一个 AI 生成任务（含进行中/刚完成），供前端刷新或切页回来后恢复状态。

    - running：后台仍在生成，前端提示"生成中"并轮询到完成（刷新/切页不会打断，结果照常落库）
    - recent：最近一次任务（done/error），用于提示"上次生成结果"
    """
    # 顺带懒清理：前端轮询状态时也能触发僵尸解锁，无需用户发起新生成
    _sweep_stale_tasks(db, novel_id)
    running = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id, AgentTask.status == "running")
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    recent = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id)
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    def to_dict(t: AgentTask) -> dict:
        return {
            "id": str(t.id),
            "agent": t.agent,
            "status": t.status,
            "msg": t.msg,
            "error": t.error,
            "chapter_no": (t.params or {}).get("chapter_no"),
            "started_at": _iso_utc(t.created_at),
            "updated_at": _iso_utc(t.updated_at),
        }

    return {
        "running": to_dict(running) if running else None,
        "recent": to_dict(recent) if recent else None,
    }


def _task_to_dict(task: AgentTask) -> dict:
    """序列化任务恢复所需的完整上下文，params 是恢复业务弹窗的唯一依据。"""
    return {
        "id": str(task.id),
        "agent": task.agent,
        "status": task.status,
        "params": task.params or {},
        "msg": task.msg,
        "error": task.error,
        "started_at": _iso_utc(task.created_at),
        "updated_at": _iso_utc(task.updated_at),
        "progress": PROGRESS.get(str(task.id), {"thinking": "", "draft": ""}),
    }


@router.get("/tasks")
def running_tasks(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """查询该小说全部进行中的 AI 任务，供工作台进入时统一恢复。

    页面不依赖前端缓存判断生成状态；任务上下文、思考过程和正文进度均以
    AgentTask + 运行期进度为准。一个小说可同时存在多个不同角色任务。
    """
    _sweep_stale_tasks(db, novel_id)
    tasks = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id, AgentTask.status == "running")
        .order_by(AgentTask.created_at.asc())
    ).scalars().all()
    return {
        "tasks": [_task_to_dict(task) for task in tasks],
        "pending_confirms": get_pending_confirms(db, novel_id),
    }


@router.get("/{agent}/tasks")
def agent_running_tasks(agent: str, novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """查询该小说该角色是否有进行中的生成任务，供兼容现有页面恢复逻辑。"""
    if agent not in AGENT_NAMES:
        raise HTTPException(404, f"未知角色：{agent}（可选：{', '.join(AGENT_NAMES)}）")
    _sweep_stale_tasks(db, novel_id, agent)
    task = db.execute(
        select(AgentTask)
        .where(AgentTask.novel_id == novel_id, AgentTask.agent == agent, AgentTask.status == "running")
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    return {
        "running": task is not None,
        "task": _task_to_dict(task) if task else None,
        # 该角色待作者确认的请求（生成任务在确认点暂停等待）：刷新恢复弹窗用
        "pending_confirms": get_pending_confirms(db, novel_id, agent=agent),
    }


@router.get("/confirm")
def list_author_confirms(
    novel_id: uuid.UUID | None = None, agent: str | None = None, db: Session = Depends(get_db)
):
    """查询待作者确认的请求。

    novel_id 传入时只查该小说；缺省时返回所有小说的待确认项（全局确认提醒中心跨小说轮询用，
    用于"不在对应小说工作台也要提醒作者去确认"）。agent 传入时只返回该角色的确认点。
    """
    return {"items": get_pending_confirms(db, novel_id, agent=agent)}


@router.post("/confirm")
def submit_author_confirm(payload: AuthorConfirmSubmitRequest, db: Session = Depends(get_db)):
    """作者提交确认答案：把 pending 置为 answered，后台生成任务轮询到后读取选择继续生成。

    answer 为选项 id 或自定义方向文本；note 为作者补充说明（可选）。
    已答复/不存在的确认请求返回 409/404。
    """
    try:
        return answer_author_confirm(
            db, payload.confirm_id, payload.answer, payload.note, field_answers=payload.field_answers
        )
    except ValueError as e:
        # 区分 404（不存在）与 409（已处理）：已答复的重复提交不是错误，幂等返回即可，
        # 前端可能因网络抖动重发；这里统一按 404 处理，前端遇到即关弹窗刷新。
        if "不存在" in str(e):
            raise HTTPException(404, str(e))
        raise HTTPException(409, str(e))


@router.post("/confirm/{confirm_id}/dismiss")
def dismiss_author_confirm(confirm_id: uuid.UUID, db: Session = Depends(get_db)):
    """作者主动跳过确认点：dismissed，后台任务按默认方向继续生成。

    关闭弹窗即跳过（不等完整确认超时窗口），生成任务立刻恢复。
    """
    try:
        return pipeline_dismiss_author_confirm(db, confirm_id)
    except ValueError as e:
        if "不存在" in str(e):
            raise HTTPException(404, str(e))
        raise HTTPException(409, str(e))


@router.post("/{agent}/run")
async def stream_agent_run(agent: str, payload: AgentRunRequest, db: Session = Depends(get_db)):
    """通用流式生成入口：context_ready → stream_delta* → stream_end → schema_validate → stored。

    dry_run=true（调试沙箱）时最后 stored 事件返回产出而不落库，用户可另调 commit 加入正式库。

    任务持久化：先落 agent_tasks（running），再启动后台任务跑生成；SSE 只转发事件。
    请求断开（刷新页面）不影响后台任务，完成后自动落库并更新任务状态。
    """
    if agent not in AGENT_NAMES:
        raise HTTPException(404, f"未知角色：{agent}（可选：{', '.join(AGENT_NAMES)}）")

    # 蓝图师前置校验：设定库为空时没有素材来源，直接拒绝（前端已禁用，这里兜底防绕过）。
    # 蓝图必须从设定出发，即使填了生成要求也不允许在零设定的情况下凭空生成。
    # 例外：导入模式（params.import_source）的素材来自用户上传的大纲文档，不受此限。
    if agent == "blueprint_architect" and not (payload.params or {}).get("import_source"):
        from app.agents.context import get_settings_snapshot

        if len(get_settings_snapshot(db, payload.novel_id)) == 0:
            raise HTTPException(
                400,
                "设定库为空，无法生成蓝图。请先在「设定」中添加角色、地点、规则等设定。",
            )

    if agent == "novelist" and ((payload.params or {}).get("mode") == "expand" or (payload.params or {}).get("writing_mode") == "expand"):
        expand_params = payload.params or {}
        chapter_no = expand_params.get("chapter_no")
        parent_id = expand_params.get("parent_version_id")
        if chapter_no is None or parent_id is None:
            raise HTTPException(422, "AI 扩写必须指定 chapter_no 和 parent_version_id")
        if not str(expand_params.get("source_content") or expand_params.get("content") or "").strip():
            raise HTTPException(422, "AI 扩写原稿不能为空")
        chapter = db.execute(select(Chapter).where(Chapter.novel_id == payload.novel_id, Chapter.chapter_no == int(chapter_no))).scalar_one_or_none()
        if chapter is None:
            raise HTTPException(404, "章节不存在或不属于该小说")
        try:
            parent = db.get(ChapterVersion, uuid.UUID(str(parent_id)))
        except (ValueError, TypeError):
            parent = None
        if parent is None or parent.chapter_id != chapter.id:
            raise HTTPException(404, "扩写父版本不存在或不属于该章节")
        payload.params = {**expand_params, "source_content": str(expand_params.get("source_content") or expand_params.get("content")), "parent_version_id": str(parent.id), "writing_mode": "expand"}

    # 先懒清理该 novel+agent 的僵尸任务（失联超时无心跳的 running），再查并发位，
    # 否则进程中断遗留的 running 会永远占位导致 409，只能靠重启后端（生产不可取）。
    _sweep_stale_tasks(db, payload.novel_id, agent)
    # 同 novel + agent 已有进行中任务：拒绝重复启动（如刷新后误点），等它跑完
    existing = db.execute(
        select(AgentTask).where(
            AgentTask.novel_id == payload.novel_id,
            AgentTask.agent == agent,
            AgentTask.status == "running",
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, "该角色已有生成任务在后台运行，请等待完成后再试。")

    # 信息控制（谁知道了什么）生效合并：生成正文前，按「全局默认 + 已定稿章节链 + 本章填的」计算
    # 生效信息（同名后者覆盖、不同名合并），注入 params 供 novelist 使用；
    # 本章填的原文另存一份，落库时写入 chapters.info_control（不可事后编辑，重写覆盖）。
    if agent == "novelist":
        from app.services.info_control import effective_info_control

        chapter_no = (payload.params or {}).get("chapter_no")
        if chapter_no is not None:
            own = (payload.params or {}).get("info_control") or {}
            effective = effective_info_control(db, payload.novel_id, int(chapter_no), own)
            payload.params = {**(payload.params or {}), "info_control": effective, "_chapter_info_control": own or None}

    task = AgentTask(novel_id=payload.novel_id, agent=agent, params=payload.params or {})
    db.add(task)
    db.commit()
    db.refresh(task)

    # 后台任务与 SSE 连接之间的转发队列。连接断开后无人消费，事件被丢弃（不阻塞后台任务）。
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    _SENTINEL = object()

    async def _run_background(task_db: Session, task: AgentTask) -> None:
        """后台生成主体：流式跑完并落库，最后把 agent_tasks 标记 done。

        正文生成（novelist/reviser）成功后不再自动排队评价：评价只由作者手动触发
        （「评价与优化」面板），避免高频评价消耗高成本模型。
        """
        # 作者确认弹窗的 SSE 实时通知：把 author_confirm 事件塞进转发队列，
        # 在线前端立即弹窗；刷新/断线用户靠轮询 pending 确认接口恢复弹窗。
        def _emit_author_confirm(confirm: dict) -> None:
            try:
                queue.put_nowait(
                    f"event: author_confirm\ndata: {json.dumps({'confirm': confirm}, ensure_ascii=False)}\n\n"
                )
            except asyncio.QueueFull:
                pass

        # 前置子代理（时代研究/蓝图质检/方向提案/章节规划）的思考过程实时转发：
        # 让用户在等确认、等主生成时看到模型正在思考，而不是长时间空白占位。
        def _emit_stream(sse_text: str) -> None:
            # 关键：前置阶段不在 run_agent_stream 主循环里，thinking_delta 若不累积进
            # PROGRESS，刷新/断线后恢复轮询读不到已流出的思考内容 → 生成弹窗「思考过程」
            # 模块消失、只剩占位文字。这里统一转发 + 累积，保证刷新后思考内容可恢复。
            _update_progress(task.id, sse_text)
            try:
                queue.put_nowait(sse_text)
            except asyncio.QueueFull:
                pass

        # 大纲生成前置：咨询作者「下一步发展脉络方向」。
        # 方向提案师基于与大纲师同一套素材产出 3 个候选，作者选择或自定义输入后注入生成；
        # 重写（rewrite）方向已定、不咨询；作者忽略/超时则不注入（大纲师自行把握）。
        if agent == "outliner" and not payload.dry_run and not (payload.params or {}).get("rewrite"):
            try:
                author_dir = await _propose_outline_direction(
                    task_db, payload.novel_id, payload.params, task.id,
                    on_pending=_emit_author_confirm, on_stream=_emit_stream,
                )
                if author_dir:
                    payload.params["author_direction"] = author_dir
            except Exception:
                logger.exception("novel_id=%s 大纲方向提案异常（不阻断生成）", payload.novel_id)

        # 正文前置规划（approved 大纲）回滚快照：正文整体失败时恢复该章大纲原状——
        # persist_chapter_plan 会插入新 approved 大纲并把同章旧 approved 降回 draft，
        # 若正文生成失败而大纲残留，作者会看到「正文失败但大纲却显示已批准/旧版被降级」的错位。
        # 必须在下面的 novelist 前置规划（_snapshot_chapter_plans 调用）之前定义，
        # 否则调用发生在 def 执行前会抛 UnboundLocalError，导致已确认的本章规划不落库。
        plan_snapshot: dict | None = None
        plan_outline_id: str | None = None

        def _snapshot_chapter_plans() -> None:
            """拍下本章大纲各版本当前状态，供正文失败时回滚（persist_chapter_plan 会插入/降级版本）。"""
            nonlocal plan_snapshot
            from app.db.models import Outline

            chapter_no = payload.params.get("chapter_no")
            rows = task_db.query(Outline).filter(
                Outline.novel_id == payload.novel_id, Outline.chapter_no == chapter_no
            ).all()
            plan_snapshot = {str(r.id): r.status for r in rows}

        def _restore_chapter_plans() -> None:
            """正文整体失败时恢复本章大纲：删除本次新插入的 approved 版，恢复被降级的旧批准版。"""
            if plan_snapshot is None:
                return
            from app.db.models import Outline

            chapter_no = payload.params.get("chapter_no")
            rows = task_db.query(Outline).filter(
                Outline.novel_id == payload.novel_id, Outline.chapter_no == chapter_no
            ).all()
            # ① 删除本次前置规划新插入的 approved 大纲
            if plan_outline_id:
                for r in rows:
                    if str(r.id) == plan_outline_id:
                        task_db.delete(r)
                        break
            # ② 恢复被 persist_chapter_plan 降级为 draft 的旧批准版
            for r in task_db.query(Outline).filter(
                Outline.novel_id == payload.novel_id, Outline.chapter_no == chapter_no
            ).all():
                if plan_snapshot.get(str(r.id)) == "approved" and r.status != "approved":
                    r.status = "approved"
            task_db.commit()

        # 正文生成前置：咨询作者「本章规划」（大纲+章节合并方案）。
        # 章节规划师基于与大纲师同一套素材把本章规划拆成 3 个维度（核心事件/叙事方案/执行收尾），
        # 作者逐项选择或自定义，组合的方案落库为 approved 大纲（轻量版）并注入 novelist 参数据此写正文；
        # 重新生成=新增，照常咨询（方向由作者重新定夺）；
        # 仅批量自动重写（auto_rewrite，无人工确认环节）跳过咨询，避免打断批量自动化；
        # 作者忽略/超时则不注入（novelist 按既有方式续写）。
        if agent == "novelist" and not payload.dry_run and not (payload.params or {}).get("auto_rewrite"):
            try:
                plan = await _propose_chapter_plan(
                    task_db, payload.novel_id, payload.params, task.id,
                    on_pending=_emit_author_confirm, on_stream=_emit_stream,
                )
                if plan:
                    from app.services.pipeline import persist_chapter_plan

                    # 记录正文失败时要回滚的大纲快照（本次会插入 approved 并降级旧批准版）
                    _snapshot_chapter_plans()
                    outline_id = persist_chapter_plan(
                        task_db, payload.novel_id, payload.params.get("chapter_no"), plan
                    )
                    plan_outline_id = str(outline_id)
                    payload.params["outline_id"] = str(outline_id)
                    payload.params["outline"] = _plan_to_outline_text(plan)
                    payload.params["chapter_function"] = plan.get("chapter_function") or "progression"
                    payload.params["goal"] = plan.get("goal") or ""
                    if plan.get("title"):
                        payload.params["title"] = plan.get("title")
                    payload.params["writing_mode"] = "outline_guided"

                    # 正文生成前置（第 2 阶段）：本章规划定稿后把本章拆成 3-5 个场景逐字段确认，
                    # 再对每个场景生成 5 个写法提案六选一；作者任一确认点跳过/超时则放弃场景
                    # 规划（novelist 按本章规划方案续写，不阻断生成）。
                    scene_plan = await _propose_scene_plan(
                        task_db, payload.novel_id, payload.params, task.id, plan,
                        on_pending=_emit_author_confirm, on_stream=_emit_stream,
                    )
                    if scene_plan:
                        payload.params["scene_plan"] = scene_plan
            except Exception:
                logger.exception("novel_id=%s 本章规划前置异常（不阻断生成）", payload.novel_id)

        # 蓝图前置研究写入快照：蓝图整体失败（如 schema 校验失败）时回滚这些副作用，
        # 保持「蓝图导入要么整体成功、要么整体失败」的原子语义——失败后不得残留
        # 时代行业研究 / 背景类型 / 题材等半套设定，否则作者会看到「蓝图失败但设定却有数据」。
        from app.db.models import Novel

        prereq_snapshot: dict | None = None

        def _snapshot_blueprint_prereq() -> dict:
            """拍下蓝图前置研究将要改动的 Novel 字段，供整体失败时回滚。"""
            n = task_db.get(Novel, payload.novel_id)
            return {
                "era_research": n.era_research if n else None,
                "background_type": n.background_type if n else None,
                "genres": list(n.genres) if n and n.genres is not None else None,
            }

        def _restore_blueprint_prereq() -> None:
            """蓝图整体失败时恢复前置研究写入的 Novel 字段（保持「要么整体成功要么整体失败」）。"""
            if prereq_snapshot is None:
                return
            n = task_db.get(Novel, payload.novel_id)
            if n is None:
                return
            n.era_research = prereq_snapshot["era_research"]
            n.background_type = prereq_snapshot["background_type"]
            n.genres = prereq_snapshot["genres"]
            task_db.commit()

        # 蓝图生成前置：首次自动研究「年代×行业」（运行时按需，替代内置知识包）。
        # 非 dry_run（dry_run 是调试沙箱不落库）；研究失败/已存在/纯架空时内部自行跳过。
        # 研究结论以 author_confirm 弹窗交给作者确认（on_pending 实时通知在线前端弹窗）。
        if agent == "blueprint_architect" and not payload.dry_run:
            # 前置研究会在确认后落库 novel.era_research（apply_fix 还会改写背景类型/题材），
            # 先拍快照：本次蓝图若整体失败，由 _restore_blueprint_prereq 恢复原值
            prereq_snapshot = _snapshot_blueprint_prereq()
            try:
                material = (payload.params or {}).get("import_source") or ""
                if not material:
                    from app.agents.context import format_settings_for_prompt, get_settings_snapshot
                    material = format_settings_for_prompt(get_settings_snapshot(task_db, payload.novel_id))

                era_result = await _ensure_era_research(
                    task_db, payload.novel_id, material,
                    on_pending=_emit_author_confirm, on_stream=_emit_stream,
                    task_id=task.id,  # 透传主任务 id：时代确认等待期间保持心跳，防懒清理误杀
                )
                if era_result.get("research"):
                    # 研究完成提示（仅前端展示，不累积到刷新恢复缓存）
                    try:
                        queue.put_nowait(
                            f"event: notify\ndata: {json.dumps({'message': '已完成年代×行业研究（可稍后在项目设置查看/修改）'}, ensure_ascii=False)}\n\n"
                        )
                    except asyncio.QueueFull:
                        pass
            except Exception:
                logger.exception("novel_id=%s 蓝图研究前置异常（不阻断生成）", payload.novel_id)

            # 蓝图导入质检：质检师找导入文档「内部」的模糊/矛盾/缺失/质量/合规疑点，
            # 逐条弹窗问作者怎么处理（vague/conflict/missing 的答复注入蓝图师正式生成，
            # quality/compliance 为知情确认，作者选「取消生成」则中止本次蓝图生成）。
            if (payload.params or {}).get("import_source"):
                try:
                    precheck = await _ensure_blueprint_issues(
                        task_db, payload.novel_id, payload.params, task.id,
                        on_pending=_emit_author_confirm, on_stream=_emit_stream,
                    )
                    if precheck and precheck.get("cancelled"):
                        try:
                            queue.put_nowait(
                                f"event: notify\ndata: {json.dumps({'message': '已取消本次蓝图生成（未生成蓝图）'}, ensure_ascii=False)}\n\n"
                            )
                        except asyncio.QueueFull:
                            pass
                        return
                    if precheck and precheck.get("resolutions"):
                        payload.params["issue_resolutions"] = precheck["resolutions"]
                        try:
                            queue.put_nowait(
                                f"event: notify\ndata: {json.dumps({'message': f'已按你的意见处理 {len(precheck["resolutions"])} 处蓝图疑点'}, ensure_ascii=False)}\n\n"
                            )
                        except asyncio.QueueFull:
                            pass
                except Exception:
                    logger.exception("novel_id=%s 蓝图导入质检前置异常（不阻断生成）", payload.novel_id)
        try:
            async for sse in run_agent_stream(
                task_db,
                agent,
                payload.novel_id,
                payload.params,
                temperature=payload.temperature,
                max_tokens=payload.max_tokens,
                dry_run=payload.dry_run,
                task_id=task.id,  # 心跳：生成期间定期刷新 updated_at，供懒清理判死僵尸任务
            ):
                _update_progress(task.id, sse)  # 累积流式文字，供刷新后恢复显示
                try:
                    queue.put_nowait(sse)
                except asyncio.QueueFull:
                    pass  # 连接已断/消费慢：丢弃事件，生成照常跑完并落库
        except Exception:
            # 主产出整体失败：回滚前置环节写入的副作用，
            # 保持「全部成功才算完成，任一失败即整体失败」的原子语义
            if agent == "blueprint_architect":
                try:
                    _restore_blueprint_prereq()
                except Exception:
                    logger.exception("novel_id=%s 蓝图前置研究回滚失败", payload.novel_id)
            if agent == "novelist":
                try:
                    _restore_chapter_plans()
                except Exception:
                    logger.exception("novel_id=%s 正文前置规划大纲回滚失败", payload.novel_id)
            raise
        if not payload.dry_run:
            # 自动评价已移除：评价模型成本高，评价只允许作者手动触发（「评价与优化」面板手动评价）。
            # 依赖评价结果的数据（如优化/修订）也只在手动评价成功后才由前端发起，正文生成不再自动评价。
            try:
                _schedule_memory_keeper(task_db, payload.novel_id, agent, payload.params)
            except Exception:
                # 编年触发失败不影响正文落库，仅记日志（下个触发章节会再次尝试）
                logger.exception("novel_id=%s 编年触发失败（不影响正文落库）", payload.novel_id)
        _finish_task(task_db, task.id, status="done", msg="生成完成")

    async def background_run() -> None:
        # 独立会话：任务脱离请求生命周期（get_db 的会话随请求结束关闭，不能用）
        task_db = SessionLocal()
        # 整体超时兜底：LLM 请求已单独限时（LLM_REQUEST_TIMEOUT_SECONDS），这里再留
        # 足够缓冲（含重试/校验/落库），防止极端情况（如 LLM 层异常未抛）下任务永久
        # running——那会让「提取/生成没落库、按钮一直高亮」且前端永远显示"进行中"。
        # 用 _ConfirmAwareTimeout：等作者确认的时间不占用该预算（pipeline 确认等待
        # 时会自动顺延/回退 deadline），避免确认等待耗尽预算导致任务被误杀。
        keeper = _ConfirmAwareTimeout(TASK_ABSOLUTE_TIMEOUT_SECONDS)
        token = set_confirm_wait_extender(keeper.extend)
        try:
            try:
                async with keeper.timeout:
                    await _run_background(task_db, task)
            except TimeoutError:
                logger.error("agent=%s task=%s 后台任务超时终止（%ss 未完成）", agent, task.id, TASK_ABSOLUTE_TIMEOUT_SECONDS)
                _finish_task(task_db, task.id, status="error", error="生成超时，已自动终止，请重试。")
                try:
                    queue.put_nowait(_SENTINEL)
                except asyncio.QueueFull:
                    pass
            except Exception as e:
                logger.exception("agent=%s task=%s 后台生成失败", agent, task.id)
                _finish_task(task_db, task.id, status="error", error=str(e))
                try:
                    queue.put_nowait(_SENTINEL)
                except asyncio.QueueFull:
                    pass
        finally:
            reset_confirm_wait_extender(token)
            PROGRESS.pop(str(task.id), None)
            task_db.close()
            try:
                queue.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                pass

    asyncio.create_task(background_run())

    async def sse():
        """SSE 转发循环：从队列取事件逐个 yield；客户端断开（CancelledError）时只退出
        转发循环，后台任务继续跑完并落库（刷新页面不中断生成）。"""
        try:
            while True:
                item = await queue.get()
                if item is _SENTINEL:
                    break
                yield item
        except asyncio.CancelledError:
            # 客户端断开（如刷新页面）：只退出转发循环，后台任务继续
            raise

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 关掉反代缓冲，保证流式
        },
    )


@router.post("/{agent}/commit")
async def commit_agent_run(agent: str, payload: AgentCommitRequest, db: Session = Depends(get_db)):
    """把调试 dry_run 的产物显式加入正式库（不重新调用 AI，复用各角色 _persist）。"""
    if agent not in AGENT_NAMES:
        raise HTTPException(404, f"未知角色：{agent}（可选：{', '.join(AGENT_NAMES)}）")
    try:
        return await commit_agent_output(db, agent, payload.novel_id, payload.params, payload.output, payload.source)
    except Exception as e:
        logger.exception("agent=%s commit 失败", agent)
        raise HTTPException(422, f"提交失败：{e}")
