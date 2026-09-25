"""Pipeline 核心：Agent 统一接口编排，SSE 事件流（技术设计 §10）。

事件流（单版本）：context_ready → stream_delta* → stream_end → schema_validate → stored
事件流（多版本，如 novelist 双版本，§8）：
    context_ready{version_count}
    → 每版本：version_start → stream_delta* → stream_end → schema_validate
    → stored{versions:[...]}

- 多版本并行调用 LLM（asyncio.gather），事件按版本顺序播放，前端可清晰区分版本。
- 产出 schema 校验失败 → 携带错误自纠错重试 1 次 → 仍失败 → 落 quality_reviews 告警 + 事件标记。
- 结构化入库由各角色 _persist 钩子完成（M0 extractor 入库 story_state；M1 novelist 入库 chapters + chapter_versions）。
"""
import asyncio
import contextvars
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.registry import get_agent
from app.db.models import (
    AgentTask,
    Chapter,
    ChapterVersion,
    EntityRelation,
    Novel,
    PlotLedger,
    QualityReview,
    Setting,
    StoryState,
)

logger = logging.getLogger(__name__)

MAX_SCHEMA_RETRY = 1  # 自纠错重试次数（技术设计 §5 通用约定）
# 空输出自动重试次数：推理模型（如火山 deepseek-v4-flash）偶发"只思考不输出正文"（content 为空），
# 触发 schema 校验失败。这种情况没有"错误"可纠正，直接干净重跑，最多额外重试 MAX_EMPTY_RETRY 次。
MAX_EMPTY_RETRY = 3
# SSE 心跳间隔：推理模型长首 token（1-3 分钟）期间连接零字节闲置，中间代理/网关可能掐断连接，
# 表现为前端"生成失败"而后端无错、未落库。超时未产出则发 ping 保活，事件本身被前端忽略。
SSE_KEEPALIVE_SECONDS = 15
# 内容增量轮询间隔（秒）：思考期内容队列长时间为空，主循环按此频率轮询，
# 保证「思考增量」能逐段实时下发（而非攒满一个心跳周期 15s 才倒一次）。
SSE_POLL_INTERVAL = 0.25
# AgentTask 心跳写入间隔（秒）：后台生成任务存活期间定期刷新 updated_at。
# 请求入口的懒清理据此判死——running 且长时间无心跳的任务视为僵尸，自动标 error 释放并发位。
HEARTBEAT_INTERVAL_SECONDS = 30


class SchemaValidationError(Exception):
    """角色产出多次自纠错后仍未通过 schema 校验。

    由后台任务层捕获并把 agent_tasks 标为 error——避免「任务 done 但正文未落库」的误导。
    """


def _event(name: str, data: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def run_agent_stream(
    db: Session,
    agent_name: str,
    novel_id: uuid.UUID,
    params: dict,
    *,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    dry_run: bool = False,
    task_id: Optional[uuid.UUID] = None,
) -> AsyncIterator[str]:
    """通用流式生成入口：返回 SSE 格式文本流。自动识别单/多版本。

    dry_run=True：只生成不落库（调试沙箱），stored 事件携带产出，由用户决定是否
    通过 commit 接口显式加入正式库。

    task_id：后台 AgentTask 行 id。生成期间每 HEARTBEAT_INTERVAL_SECONDS 刷新一次
    updated_at 作为心跳，供请求入口的懒清理把失联任务判死解锁（不依赖重启后端）。
    """
    last_touch = 0.0

    async def _heartbeat() -> None:
        nonlocal last_touch
        if task_id is None:
            return
        now = time.monotonic()
        if now - last_touch < HEARTBEAT_INTERVAL_SECONDS:
            return
        last_touch = now
        try:
            t = db.get(AgentTask, uuid.UUID(str(task_id)))
            if t is not None and t.status == "running":
                t.updated_at = datetime.utcnow()
                db.commit()
        except Exception:
            db.rollback()  # 心跳失败不影响生成，仅失去心跳（下次懒清理可能判死该任务）

    async for sse in _run_agent_stream_raw(
        db, agent_name, novel_id, params,
        temperature=temperature, max_tokens=max_tokens, dry_run=dry_run,
    ):
        await _heartbeat()
        yield sse


async def _run_agent_stream_raw(
    db: Session,
    agent_name: str,
    novel_id: uuid.UUID,
    params: dict,
    *,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    dry_run: bool = False,
) -> AsyncIterator[str]:
    """流式生成主体（run_agent_stream 的原始实现，事件产生处由心跳包装驱动）。"""
    agent: Agent = get_agent(db, agent_name)
    base_ctx: ContextPack = agent.build_context(novel_id, params)
    if temperature is not None:
        base_ctx.temperature = temperature
    if max_tokens is not None:
        base_ctx.max_tokens = max_tokens

    versions: list[ContextPack] = agent.build_versioned_contexts(base_ctx)

    yield _event("context_ready", {
        "agent": agent_name,
        "meta": base_ctx.meta,
        "version_count": len(versions),
        "dry_run": dry_run,
    })

    if len(versions) == 1:
        async for sse in _stream_single(db, agent, versions[0], agent_name, novel_id, params, dry_run):
            yield sse
        return

    # ---------- 多版本：并行流式采集，按版本顺序播放事件 ----------
    # 采集期间连接同样可能长时间闲置（长首 token），边等边发 ping 保活
    gather_task = asyncio.create_task(
        asyncio.gather(*[_collect_version(agent, vctx) for vctx in versions], return_exceptions=True)
    )
    while not gather_task.done():
        done, _ = await asyncio.wait({gather_task}, timeout=SSE_KEEPALIVE_SECONDS)
        if not done:
            yield _event("ping", {})
    results = gather_task.result()
    stored_list: list[dict] = []
    for vctx, result in zip(versions, results):
        version = vctx.meta.get("version") or agent.version_source(versions.index(vctx))
        yield _event("version_start", {"version": version})

        if isinstance(result, BaseException):
            logger.exception("agent=%s version=%s 流式调用失败", agent_name, version)
            yield _event("stream_error", {"version": version, "message": str(result)})
            continue

        text, deltas = result
        for piece in deltas:
            yield _event("stream_delta", {"version": version, "delta": piece})
        yield _event("stream_end", {"version": version, "text_length": len(text)})

        parsed, ok, retried, last_error = await _validate_with_retry(agent, vctx, text, db)
        yield _event("schema_validate", {
            "version": version,
            "status": "ok" if ok else "error",
            "retried": retried,
        })

        if ok and parsed is not None:
            if dry_run:
                stored_list.append({"version": version, "data": parsed.model_dump(mode="json")})
            else:
                stored_list.append(_persist(db, agent_name, novel_id, params, parsed, source=version))
            # 写后设定自检：作家类产出（有 content）才核对，评审/大纲类没有正文可核
            body = getattr(parsed, "content", None)
            if isinstance(body, str) and body.strip():
                gaps = _check_setting_gaps(db, novel_id, body)
                if gaps:
                    yield _event("setting_warning", {"version": version, "items": gaps})
        else:
            _alert_schema_error(db, agent_name, novel_id, version, last_error)
            yield _event("stored", {"action": "alert", "version": version, "detail": "schema_error"})

    if dry_run:
        yield _event("stored", {"action": "dry_run", "versions": stored_list})
    else:
        yield _event("stored", {"action": "persisted", "versions": stored_list})


async def _collect_version(agent: Agent, vctx: ContextPack) -> tuple[str, list[str]]:
    """采集单个版本的完整文本与全部 delta（并行时用）。"""
    text = ""
    deltas: list[str] = []
    async for piece in agent.run(vctx):
        text += piece
        deltas.append(piece)
    return text, deltas


async def _stream_single(
    db: Session,
    agent: Agent,
    ctx: ContextPack,
    agent_name: str,
    novel_id: uuid.UUID,
    params: dict,
    dry_run: bool = False,
) -> AsyncIterator[str]:
    """单版本路径（原逻辑）：context_ready → delta* → end → validate → stored。

    推理模型（deepseek 系）在正式输出前有较长的思考期（首 token 可达 1-3 分钟）。
    期间把 reasoning_content 通过 thinking_delta 事件逐段下发，前端滚动展示"思考中"，
    避免用户误以为卡死。
    """

    async def generate(result_holder: list[str]) -> AsyncIterator[str]:
        """调用一次 LLM 并流式下发事件，最终文本写入 result_holder[0]。"""
        text = ""
        reason_q: asyncio.Queue[str] = asyncio.Queue()

        async def on_reason(r: str) -> None:
            reason_q.put_nowait(r)

        async def drain_reason() -> AsyncIterator[str]:
            while not reason_q.empty():
                yield _event("thinking_delta", {"delta": reason_q.get_nowait()})

        it = agent.run(ctx, on_reason=on_reason)
        # 关键修复：不要在等待超时时 cancel 生成器。
        # 原实现 asyncio.wait_for(it.__anext__(), timeout=15) 会在推理期（首段正文前思考
        # >15s）超时，把 CancelledError 抛进生成器，流被永久终止 → 表现为"只思考不输出正文"。
        # 改为：后台任务持续推进生成器（永不取消），主循环只对队列超时读，超时发 ping 保活。
        q: asyncio.Queue[str] = asyncio.Queue()
        pump_done = asyncio.Event()
        pump_error: list[BaseException | None] = [None]

        async def pump() -> None:
            try:
                async for piece in it:
                    await q.put(piece)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # LLM 层异常，交给主循环抛给调用方
                pump_error[0] = e
            finally:
                pump_done.set()

        pump_task = asyncio.create_task(pump())
        try:
            last_ping = time.monotonic()
            while True:
                # 先排空当前已累积的思考增量：思考期逐段实时下发（不等内容出现才一起倒出来）
                async for ev in drain_reason():
                    yield ev
                if pump_done.is_set() and q.empty():
                    break
                try:
                    # 短轮询内容增量：模型每生成一小段立刻推送，而非攒满 15s 一次性给
                    piece = await asyncio.wait_for(q.get(), timeout=SSE_POLL_INTERVAL)
                    text += piece
                    yield _event("stream_delta", {"delta": piece})
                    last_ping = time.monotonic()
                except asyncio.TimeoutError:
                    # 无内容增量（通常处于思考期）：静默超过保活间隔才发 ping，避免高频空转
                    if time.monotonic() - last_ping >= SSE_KEEPALIVE_SECONDS:
                        yield _event("ping", {})
                        last_ping = time.monotonic()
            async for ev in drain_reason():
                yield ev
            if pump_error[0] is not None:
                raise pump_error[0]
            result_holder[0] = text
        finally:
            pump_task.cancel()

    result: list[str] = [""]
    try:
        async for ev in generate(result):
            yield ev
    except Exception as e:  # LLM 超时/限流等
        logger.exception("agent=%s 流式生成失败（LLM 层）", agent_name)
        yield _event("stream_error", {"message": str(e)})
        # 必须抛给后台任务层标 error：仅 return 会让任务被标 done、前端误以为成功且无产物
        raise
    text = result[0]

    # 空输出自动重试：模型偶发"只思考不输出正文"（content 为空），干净重跑（不携带错误提示）
    for attempt in range(1, MAX_EMPTY_RETRY + 1):
        if text.strip():
            break
        logger.warning("agent=%s 第 %d 次生成无正文输出，自动重试（%d/%d）", agent_name, attempt, attempt, MAX_EMPTY_RETRY)
        yield _event("notify", {"message": f"模型未输出内容，正在自动重试（{attempt}/{MAX_EMPTY_RETRY}）…"})
        try:
            async for ev in generate(result):
                yield ev
        except Exception as e:
            logger.exception("agent=%s 流式重试生成失败（LLM 层）", agent_name)
            yield _event("stream_error", {"message": str(e)})
            # 必须抛给后台任务层标 error：仅 return 会让任务被标 done、前端误以为成功且无产物
            raise
        text = result[0]

    yield _event("stream_end", {"text_length": len(text)})

    if not text.strip():
        # 空输出重试耗尽：空文本不可能通过校验，跳过无意义的 schema 重试，直接按失败处理。
        # 必须抛异常让后台任务层把 agent_tasks 标 error（曾出现任务 done 但大纲/正文未落库，
        # 前端无失败提示、再次生成被 409 拒绝，用户误以为成功）。
        msg = "模型连续多次未输出内容，请稍后重试。"
        logger.error("agent=%s 连续 %d 次无正文输出，放弃", agent_name, MAX_EMPTY_RETRY + 1)
        yield _event("stream_error", {"message": msg})
        raise SchemaValidationError(msg)

    parsed, ok, retried, last_error = await _validate_with_retry(agent, ctx, text, db)
    yield _event("schema_validate", {"status": "ok" if ok else "error", "retried": retried})

    if ok and parsed is not None:
        # 写后设定自检：作家类产出（有 content）才核对；命中缺项即下发 setting_warning。
        # 放在 stored 之前下发，前端可以先亮告警再刷新章节列表。
        body = getattr(parsed, "content", None)
        gaps = _check_setting_gaps(db, novel_id, body) if isinstance(body, str) and body.strip() else []
        if gaps:
            yield _event("setting_warning", {"items": gaps})
        if dry_run:
            yield _event("stored", {"action": "dry_run", "data": parsed.model_dump(mode="json")})
        else:
            try:
                stored = _persist(db, agent_name, novel_id, params, parsed)
            except Exception as e:
                # 落库失败必须显式告知前端，并抛出标 error：
                # 否则 SSE 直接断开，前端误以为成功（曾出现修订在落库阶段崩溃却弹"优化完成"）
                logger.exception("agent=%s 落库失败（正文已生成但未保存）", agent_name)
                yield _event("stream_error", {"message": f"正文已生成但保存失败，请重试：{e}"})
                raise
            # 蓝图落库后不再自动抽取设定/文风：设定抽取（setting_extractor）与文风提炼（style_extractor）
            # 改为「设为生效中」时触发（见 blueprints.activate_blueprint），新增/生成蓝图一律不注入。
            yield _event("stored", stored)
    else:
        _alert_schema_error(db, agent_name, novel_id, error=last_error)
        yield _event("stored", {"action": "alert", "detail": "schema_error"})
        # 透传失败：抛给后台任务层把 agent_tasks 标 error，避免「任务 done 但正文未落库」误导用户
        raise SchemaValidationError(
            last_error or f"角色 {agent_name} 产出未通过 schema 校验，已自纠错 {MAX_SCHEMA_RETRY} 次仍失败"
        )


def _alert_schema_error(
    db: Session,
    agent_name: str,
    novel_id: uuid.UUID,
    version: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    """校验失败告警：落 quality_reviews（§5 通用约定），前端可提示"可重试"。"""
    detail = f"角色 {agent_name} 产出未通过 schema 校验，已自纠错 {MAX_SCHEMA_RETRY} 次仍失败"
    if version:
        detail += f"（版本 {version}）"
    if error:
        detail += f"；校验错误：{error[:500]}"
    alert = QualityReview(
        novel_id=novel_id,
        overall_score=None,
        issues=[{
            "severity": "high",
            "type": "schema_error",
            "desc": detail,
            "suggested_fix": "请重试或人工介入",
        }],
    )
    db.add(alert)
    db.commit()


def _timeline_stages_for_entity(events: list[dict], blueprint: dict) -> list[str]:
    """按时间线年份推导实体卡的生效阶段：年份 → 所在卷（focus 年份区间）→ 卷章范围 → 全书三等分。

    与 derive_stage 的三等分口径一致（前 1/3=early、中 1/3=middle、后 1/3=late），
    卷跨越两个阶段时并集标注。无法推导（无年份、无卷年份区间）返回空列表 = 不限制。
    """
    import re as _re

    from app.agents.context import derive_stage

    vols = [v for v in (blueprint.get("volumes") or []) if isinstance(v, dict)]
    vol_ranges: list[tuple[int, int, int, int]] = []  # (start_year, end_year, 章起, 章止)
    for v in vols:
        focus = str(v.get("focus") or "")
        m = _re.match(r"^\s*(\d{4})\s*[-—～~]\s*(\d{4})", focus)
        if m:
            start, end = int(m.group(1)), int(m.group(2))
        else:
            # 开区间卷（如 "2022—结局"）：起点后是汉字/占位 → 视为开放到全书末尾
            m2 = _re.match(r"^\s*(\d{4})\s*[-—～~]\s*\S", focus)
            if not m2:
                continue
            start, end = int(m2.group(1)), 9999
        rng = str(v.get("chapters_range") or "")
        mm = _re.match(r"(\d+)\s*[-—]\s*(\d+)", rng)
        if not mm:
            continue
        vol_ranges.append((start, end, int(mm.group(1)), int(mm.group(2))))
    if not vol_ranges:
        return []
    vol_ranges.sort(key=lambda x: x[0])

    years: set[int] = set()
    for e in events:
        if not isinstance(e, dict):
            continue
        y = e.get("year")
        if isinstance(y, int) and y > 0:
            years.add(y)
        period = str(e.get("period") or "")
        m = _re.match(r"^\s*(\d{4})\s*[-—～~]", period)
        if m:
            years.add(int(m.group(1)))
            m2 = _re.search(r"[-—～~]\s*(\d{4})", period)
            if m2:
                years.add(int(m2.group(1)))
    if not years:
        return []

    bp_lite = {"volumes": [{"chapters_range": str(v.get("chapters_range") or "")} for v in vols]}
    stages: set[str] = set()
    for y in years:
        # 年份可能被相邻两卷同时覆盖（如 2022 属 2018-2022 卷也属 2022-结局 卷），取最晚开卷的卷
        matches = [(cs, ce, vs) for vs, ve, cs, ce in vol_ranges if vs <= y <= ve]
        vol = max(matches, key=lambda t: t[2])[:2] if matches else None
        if vol is None:
            # 年份落在卷区间外（如早于第一卷）→ 归首卷
            vol = (vol_ranges[0][2], vol_ranges[0][3])
        cs, ce = vol
        for ch in {cs, ce, (cs + ce) // 2}:
            st = derive_stage(ch, bp_lite)
            if st:
                stages.add(st)
    order = {"early": 0, "middle": 1, "late": 2}
    result = sorted(stages, key=lambda s: order.get(s, 99))
    # 三个阶段全命中 = 全程有效，与「不限制」等价；留空更干净（前端无徽章 = 全程）
    return [] if len(result) >= 3 else result


async def seed_entity_cards_from_blueprint(
    db: Session, novel_id: uuid.UUID, blueprint_id: uuid.UUID
) -> dict:
    """从蓝图 timeline 自动生成/补全实体卡（source="blueprint"，随版本存储）。

    触发时机：蓝图被「设为生效中」时（先于设定抽取执行，与是否导入模式无关）。
    作用：把「2000年开始打工、2010年自主创业」这类时间线硬事实落成设定卡
    structured.hard_facts / locked_details，供 entity_checker 做确定性核对——
    解决"机构/人物只有一句散文描述，无法核对位置/布局/人员/业务"的问题。

    幂等：已存在的同名卡不重复建，只把 timeline 事实合并进 hard_facts（已有键不覆盖）。
    """
    from app.db.models import Blueprint

    bp = db.get(Blueprint, blueprint_id)
    if bp is None or bp.novel_id != novel_id:
        return {"action": "skipped", "created": 0, "updated": 0, "reason": "蓝图不存在"}
    content = bp.content or {}
    events = [e for e in (content.get("timeline") or []) if isinstance(e, dict)]
    if not events:
        return {"action": "skipped", "created": 0, "updated": 0, "reason": "蓝图无时间线"}

    arcs = {
        str(a.get("character", "")).strip(): a
        for a in (content.get("character_arcs") or [])
        if isinstance(a, dict) and a.get("character")
    }
    grouped: dict[str, list[dict]] = {}
    for e in events:
        ent = str(e.get("entity") or "").strip()
        if not ent:
            continue
        grouped.setdefault(ent, []).append(e)

    created = updated = 0
    for ent, evs in grouped.items():
        item_type = _infer_entity_type(ent, arcs)
        facts: dict[str, str] = {}
        locked: list[str] = []
        # 起始/结束时间（仅机构/地点出可核对硬事实，角色卡只留锁定细节，避免误判）
        if item_type in ("faction", "location"):
            first_est = next((e for e in evs if e.get("status") in (None, "established")), None)
            if first_est:
                label = _timeline_label(first_est)
                if label:
                    facts["起始时间"] = label
            ended = next((e for e in evs if e.get("status") == "ended"), None)
            if ended:
                label = _timeline_label(ended)
                if label:
                    facts["结束时间"] = label
        for e in evs:
            label = _timeline_label(e)
            ev = str(e.get("event") or "").strip()
            if label and ev:
                locked.append(f"{label}：{ev}")
        if not facts and not locked:
            continue
        # 定位已有卡：精确优先，模糊兜底；全新实体才建卡（防同名变体污染）
        row = _find_entity_setting(db, novel_id, ent)
        if row is None:
            desc = locked[0] if locked else f"{ent}（蓝图时间线自动生成的实体卡）"
            row = Setting(
                novel_id=novel_id,
                type=item_type,
                name=ent,
                description=desc,
                structured={"constitution_text": desc, "dynamic_text": ""},
                is_pinned=(len(evs) >= 2 or ent in arcs),
                source="blueprint",
                blueprint_id=blueprint_id,
            )
            db.add(row)
            db.flush()
            created += 1
        else:
            updated += 1
        st = dict(row.structured or {})
        # 生效阶段：按时间线年份推导（仅无阶段时补，不覆盖抽取师/作者已定的）
        if "stages" not in st:
            stages = _timeline_stages_for_entity(evs, content)
            if stages:
                st["stages"] = stages
        hard = dict(st.get("hard_facts") or {})
        for k, v in facts.items():
            if k not in hard:
                hard[k] = v
        locked_existing = list(st.get("locked_details") or [])
        for line in locked:
            if line not in locked_existing:
                locked_existing.append(line)
        st["hard_facts"] = hard
        st["locked_details"] = locked_existing
        row.structured = st

    # 机构档案 notes 解析（第二层：从「机构档案·」条目落机构卡档案 + 老板自动建卡）
    created, updated = _seed_from_org_archive_notes(db, novel_id, bp, created, updated)
    db.commit()
    return {"action": "seeded", "created": created, "updated": updated}


def _seed_from_org_archive_notes(
    db: Session, novel_id: uuid.UUID, bp, created: int, updated: int
) -> tuple[int, int]:
    """解析蓝图 notes 中的「机构档案·」条目 → 机构卡 hard_facts/locked_details + 老板自动建卡。

    格式约定（blueprint_architect 生成）：机构档案·江城人才信息服务部：成立时间=2000年；负责人=秦胜利；
    人员规模=3人；业务范围=职业介绍、招工代理；位置布局=汉正街临街一楼门面；时代特征=信息差红利期
    ——键值对用全角分号「；」分隔，年份/数量型维度落 hard_facts（可字面核对），
    散文型维度落 locked_details（锁定展示），「负责人/老板」单独识别为角色卡并关联机构。
    """
    import re as _re

    notes = (bp.content or {}).get("notes") or []
    if not notes:
        return created, updated
    for line in notes:
        line = str(line).strip()
        if not line.startswith("机构档案·"):
            continue
        head, sep, body = line.partition("：")
        if not sep or not body:
            continue
        org = head[len("机构档案·"):].strip()
        if not org:
            continue
        facts: dict[str, str] = {}
        locked: list[str] = []
        boss = ""
        for seg in _re.split(r"[；;]", body):
            seg = seg.strip()
            if not seg:
                continue
            if "=" in seg:
                k, _, v = seg.partition("=")
            elif "：" in seg:
                k, _, v = seg.partition("：")
            else:
                locked.append(seg)
                continue
            k = k.strip()
            v = v.strip()
            if not k or not v or v == "待定":
                continue
            if "负责人" in k or "老板" in k:
                boss = v
                locked.append(f"负责人={v}")
                continue
            # 年份/数量型 → hard_facts（可核对）；散文型 → locked_details（锁定展示）
            if _re.search(r"(1[89]\d{2}|20\d{2})", v) or _re.search(r"\d{1,4}\s*(名|人|家|间|位|个|所|处|台|套|辆|层)", v):
                facts[k] = v
            else:
                locked.append(f"{k}={v}")
        if not facts and not locked and not boss:
            continue
        row = _find_entity_setting(db, novel_id, org)
        if row is None:
            desc = locked[0] if locked else f"{org}（蓝图机构档案）"
            row = Setting(
                novel_id=novel_id,
                type="faction",
                name=org,
                description=desc,
                structured={"constitution_text": desc, "dynamic_text": ""},
                is_pinned=True,
                source="blueprint",
                blueprint_id=bp.id,
            )
            db.add(row)
            db.flush()
            created += 1
        else:
            updated += 1
        st = dict(row.structured or {})
        hard = dict(st.get("hard_facts") or {})
        for k, v in facts.items():
            if k not in hard:
                hard[k] = v
        locked_existing = list(st.get("locked_details") or [])
        for item in locked:
            if item not in locked_existing:
                locked_existing.append(item)
        st["hard_facts"] = hard
        st["locked_details"] = locked_existing
        row.structured = st
        # 老板自动建卡（character），locked_details 关联机构
        if boss:
            created, updated = _ensure_boss_card(db, novel_id, boss, org, bp.id, created, updated)
    return created, updated


def _ensure_boss_card(
    db: Session, novel_id: uuid.UUID, boss: str, org: str, blueprint_id: uuid.UUID,
    created: int, updated: int,
) -> tuple[int, int]:
    """为机构负责人建/补 character 卡（首次提及即建卡，锁定「是《机构》的负责人」关联）。"""
    boss = str(boss).strip()
    if not boss:
        return created, updated
    aff = f"是《{org}》的负责人"
    row = _find_entity_setting(db, novel_id, boss)
    if row is None:
        desc = f"{boss}：{aff}"
        row = Setting(
            novel_id=novel_id,
            type="character",
            name=boss,
            description=desc,
            structured={
                "constitution_text": desc,
                "dynamic_text": "",
                "locked_details": [aff],
            },
            is_pinned=True,
            source="blueprint",
            blueprint_id=blueprint_id,
        )
        db.add(row)
        db.flush()
        created += 1
    else:
        updated += 1
        st = dict(row.structured or {})
        locked = list(st.get("locked_details") or [])
        if aff not in locked:
            locked.append(aff)
        st["locked_details"] = locked
        row.structured = st
    return created, updated


def _timeline_label(e: dict) -> str:
    """timeline 事件的时间标签：period 优先，其次 year。"""
    label = str(e.get("period") or "").strip()
    if not label and isinstance(e.get("year"), int):
        label = f"{e['year']}年"
    return label


def _infer_entity_type(name: str, arcs: dict) -> str:
    """从实体名推断设定类型：命中人物弧 → character；机构类词 → faction；地点类词 → location。"""
    if name in arcs:
        return "character"
    if any(k in name for k in (
        "公司", "集团", "服务部", "事务所", "工作室", "中介", "机构", "餐厅",
        "银行", "学校", "医院", "厂", "店", "局", "中心", "部门", "单位",
    )):
        return "faction"
    if any(k in name for k in (
        "城", "市", "镇", "街", "区", "楼", "巷", "河", "山", "湖", "岛", "苑", "村", "大厦",
    )):
        return "location"
    return "concept"


async def _extract_settings_from_import(
    db: Session, novel_id: uuid.UUID, params: dict, blueprint_id: uuid.UUID
) -> dict:
    """把导入文档交给「设定抽取师」，将结果写入设定库（按蓝图版本存储）。

    触发时机：蓝图被「设为生效中」时（blueprints.activate_blueprint），新增/生成蓝图不触发。
    写入规则（作者约定，蓝图导入 = 按版本存储）：
    - 蓝图导入的设定全部标记 source="blueprint" 且 blueprint_id=本版本；
    - 各版本设定互不覆盖、独立保留，激活哪个蓝图前端就显示哪个版本的设定；
      切回旧版本时直接恢复显示，无需重新抽取；
    - 本次未解析出任何有效条目时不动数据（避免误写空），仅计 skipped。

    失败不阻断激活，返回 {action, created, removed, skipped} 供前端提示。
    """
    from app.agents.registry import get_agent

    # 把蓝图师整理好的结构化结果（分卷章范围 + 时间线年份）一并传给抽取师，
    # 让其能据此判断设定生效阶段——原文没写明时机时也可从年份/卷号推导，而非一律留空
    from app.db.models import Blueprint

    bp = db.get(Blueprint, blueprint_id)
    bp_content = (bp.content or {}) if bp is not None else {}

    try:
        agent = get_agent(db, "setting_extractor")
        ctx = agent.build_context(novel_id, {
            "text": params.get("import_source", ""),
            "doc_name": params.get("doc_name") or "导入的大纲文档",
            "blueprint": bp_content,
        })
        out = ""
        async for piece in agent.run(ctx):
            out += piece
        # 用带容错的 validate 而非 parse_output：模型输出可能被 ```json 代码块包裹或夹杂说明文字，
        # 直接 parse_output 会 json_invalid 导致设定抽取失败（激活已生效但设定库无数据）
        parsed = agent.validate(out)
        return _merge_settings_from_import(db, novel_id, parsed, blueprint_id)
    except Exception:
        logger.exception("agent=setting_extractor 导入设定合并失败（不阻断蓝图落库）")
        return {"action": "merged", "table": "settings", "created": 0, "removed": 0, "skipped": 0}


def _move_appear_fields(st: dict, item_type: str) -> None:
    """把抽取师返回的出现时机字段归一化进 structured（与手动批量导入格式一致）。

    - stages 只保留合法枚举（early/middle/late）；
    - appear_ranges 与 appear_from/appear_until 二选一：有 ranges 时清掉单段；
    - 数值必须为正整数，非法值直接丢弃（= 不限制）；
    - role_rank 仅 character 保留合法值，其余类型丢弃。
    """
    VALID_STAGES = {"early", "middle", "late"}
    VALID_RANKS = {"protagonist", "major", "minor", "extra"}

    stages = st.get("stages")
    if isinstance(stages, list):
        st["stages"] = [s for s in stages if isinstance(s, str) and s in VALID_STAGES]
    else:
        st.pop("stages", None)

    ranges: list[dict] = []
    raw_ranges = st.get("appear_ranges")
    if isinstance(raw_ranges, list):
        for r in raw_ranges:
            if not isinstance(r, dict):
                continue
            try:
                f = int(r.get("from"))
                u = int(r.get("until"))
            except (TypeError, ValueError):
                continue
            item: dict = {}
            if f > 0:
                item["from"] = f
            if u > 0:
                item["until"] = u
            if item:
                ranges.append(item)
    if ranges:
        st["appear_ranges"] = ranges
        st.pop("appear_from", None)
        st.pop("appear_until", None)
    else:
        st.pop("appear_ranges", None)
        for key in ("appear_from", "appear_until"):
            v = st.get(key)
            try:
                n = int(v)
            except (TypeError, ValueError):
                st.pop(key, None)
                continue
            st[key] = n if n > 0 else None
        if st.get("appear_from") is None and st.get("appear_until") is None:
            st.pop("appear_from", None)
            st.pop("appear_until", None)

    rank = st.get("role_rank")
    if item_type == "character" and isinstance(rank, str) and rank in VALID_RANKS:
        st["role_rank"] = rank
    else:
        st.pop("role_rank", None)


def _merge_settings_from_import(
    db: Session, novel_id: uuid.UUID, parsed: BaseModel, blueprint_id: uuid.UUID
) -> dict:
    """把导入文档抽取出的设定写入设定库（蓝图导入 = 按版本存储）。

    蓝图导入的设定标 source="blueprint" + blueprint_id=本版本；不同版本互不覆盖，
    激活哪个蓝图前端就显示哪个版本的设定（其余版本隐藏保留，可切回）。
    手动/批量新增（source=batch/manual）不受影响。
    本次未解析出任何有效条目时不动数据（避免误写空），仅计 skipped。
    """
    from app.schemas.agents import ConceptExtraction

    assert isinstance(parsed, ConceptExtraction)
    items: list[tuple[str, str, object]] = []
    for c in parsed.concepts:
        item_type = getattr(c, "type", "")
        name = str(getattr(c, "name", "") or "").strip()
        if not name or item_type not in {"character", "location", "faction", "world_rule", "item", "concept"}:
            continue
        items.append((item_type, name, c))

    if not items:
        db.commit()
        return {
            "action": "merged",
            "table": "settings",
            "created": 0,
            "removed": 0,
            "skipped": len(parsed.concepts),
        }

    # 按版本写入：不删其他版本，仅追加本版本解析出的设定
    created = 0
    for item_type, name, c in items:
        structured = (c.extracted or {}) if isinstance(c.extracted, dict) else {}
        description = structured.get("description") or c.raw_quote
        # 设定库 UI 依赖 structured.constitution_text / dynamic_text 展示内容（与 confirm_concept 一致）
        st = dict(structured)
        st.setdefault("constitution_text", description)
        st.setdefault("dynamic_text", "")
        _move_appear_fields(st, item_type)
        db.add(Setting(
            novel_id=novel_id,
            type=item_type,
            name=name,
            description=description,
            structured=st,
            is_constitution=(item_type == "world_rule"),
            # 关键信息固化（C）：AI 判定 importance=high 的设定固化，注入不受设定库上限影响
            is_pinned=(str(getattr(c, "importance", "") or "").lower() == "high"),
            source="blueprint",
            blueprint_id=blueprint_id,
        ))
        created += 1
    db.commit()
    return {
        "action": "merged",
        "table": "settings",
        "created": created,
        "removed": 0,
        "skipped": len(parsed.concepts) - len(items),
    }


# 文风抽取自动重试次数：LLM 调用偶发失败（超时/限流/只思考不输出导致空结果）时重跑整次抽取
MAX_STYLE_EXTRACT_RETRY = 3
STYLE_RETRY_DELAY_SECONDS = 2


async def _apply_style_from_import(
    db: Session, novel_id: uuid.UUID, params: dict, blueprint_id: uuid.UUID
) -> dict:
    """提炼导入文档中的风格要点，按蓝图版本存入 blueprint_styles。

    触发时机：蓝图被「设为生效中」时（blueprints.activate_blueprint），新增/生成蓝图不触发。
    作者约定：风格直接写入、不需要确认。该蓝图处于生效中时同时刷新 novel.style_directive；
    未生效的版本仅按版本存好，切回时直接恢复。文档中无风格类内容时不动（applied=False）；
    LLM 抽取失败自动重试 MAX_STYLE_EXTRACT_RETRY 次（含异常与空输出），全部失败才返回
    {action:"error"}，不阻断激活，由调用方记 warning 供前端提示。
    """
    from app.agents.registry import get_agent
    from app.db.models import Blueprint, BlueprintStyle

    source_doc = params.get("import_source", "")
    directive = ""
    last_err: str | None = None
    for attempt in range(1, MAX_STYLE_EXTRACT_RETRY + 1):
        try:
            agent = get_agent(db, "style_extractor")
            ctx = agent.build_context(novel_id, {"source_doc": source_doc})
            out = ""
            async for piece in agent.run(ctx):
                out += piece
            # 用带容错的 validate 而非 parse_output：模型输出可能被 ```json 代码块包裹或夹杂说明文字，
            # 直接 parse_output 会 json_invalid 导致文风抽取失败（激活已生效但风格页无数据）
            parsed = agent.validate(out)
            directive = (parsed.style_directive or "").strip()
        except Exception as e:
            last_err = str(e)
            logger.warning(
                "agent=style_extractor 第 %s/%s 次抽取失败：%s", attempt, MAX_STYLE_EXTRACT_RETRY, e
            )
            if attempt < MAX_STYLE_EXTRACT_RETRY:
                await asyncio.sleep(STYLE_RETRY_DELAY_SECONDS)
            continue
        if directive:
            break
        # 空输出：可能是推理模型偶发"只思考不输出正文"，继续重试；重试耗尽仍为空视为"文档无风格内容"
        if attempt < MAX_STYLE_EXTRACT_RETRY:
            await asyncio.sleep(STYLE_RETRY_DELAY_SECONDS)

    if not directive:
        if last_err is not None:
            logger.error(
                "agent=style_extractor 重试 %s 次后仍失败：%s", MAX_STYLE_EXTRACT_RETRY, last_err
            )
            return {"action": "error", "applied": False, "style_directive": ""}
        return {"action": "skipped", "applied": False, "style_directive": ""}

    bp = db.execute(
        select(Blueprint).where(Blueprint.id == blueprint_id).limit(1)
    ).scalar_one_or_none()
    if bp is None:
        return {"action": "skipped", "applied": False, "style_directive": ""}
    # 按蓝图版本存（幂等：同版本只存一份）
    st = db.execute(
        select(BlueprintStyle).where(BlueprintStyle.blueprint_id == blueprint_id).limit(1)
    ).scalar_one_or_none()
    if st is None:
        st = BlueprintStyle(blueprint_id=blueprint_id, novel_id=novel_id, directive=directive)
        db.add(st)
    else:
        st.directive = directive
    # 仅当该蓝图处于生效中时刷新全局文风
    if bp.status == "active":
        db.flush()  # autoflush=False：先落库，sync 里才能按 blueprint_id 查到刚写入的文风
        sync_active_blueprint_style(db, novel_id, blueprint_id)
    else:
        db.commit()
    return {"action": "applied", "applied": True, "style_directive": directive}


async def _validate_with_retry(
    agent: Agent, ctx: ContextPack, text: str, db: Session
) -> tuple[Optional[BaseModel], bool, bool, Optional[str]]:
    """校验；失败时携带错误信息自纠错重跑 1 次。返回 (parsed, ok, retried, last_error)。"""
    try:
        return agent.validate(text), True, False, None
    except (ValidationError, ValueError, json.JSONDecodeError) as e:
        logger.warning("agent=%s 首次校验失败：%s", agent.task_type, e)
        if MAX_SCHEMA_RETRY <= 0:
            return None, False, False, str(e)
        retry_msgs = ctx.messages + [{
            "role": "user",
            "content": f"你上一次的输出未通过校验，错误：{e}\n请重新输出严格符合格式的 JSON。",
        }]
        retry_ctx = ContextPack(
            novel_id=ctx.novel_id,
            agent=ctx.agent,
            system_prompt=ctx.system_prompt,
            messages=retry_msgs,
            meta=ctx.meta,
            temperature=ctx.temperature,
            max_tokens=ctx.max_tokens,
        )
        try:
            retry_text = ""
            async for piece in agent.run(retry_ctx):
                retry_text += piece
            return agent.validate(retry_text), True, True, None
        except (ValidationError, ValueError, json.JSONDecodeError) as e2:
            logger.warning("agent=%s 自纠错后仍失败：%s", agent.task_type, e2)
            return None, False, True, str(e2)


def _persist(
    db: Session,
    agent_name: str,
    novel_id: uuid.UUID,
    params: dict,
    parsed: BaseModel,
    source: Optional[str] = None,
) -> dict:
    """结构化产出入库（M1：extractor→story_state，novelist→chapters+versions；M2：outliner→outlines+ledger，critic→quality_reviews；M3：blueprint_architect→blueprints，setting_extractor→concept_cards）。"""
    if agent_name == "extractor":
        return _persist_extractor(db, novel_id, params, parsed)
    if agent_name == "novelist":
        return _persist_novelist(db, novel_id, params, parsed, source)
    if agent_name == "reviser":
        # 修订师产出与小说家同构（完整章节正文），复用定稿逻辑，版本来源标记为 reviser
        return _persist_novelist(db, novel_id, params, parsed, "reviser")
    if agent_name == "outliner":
        return _persist_outliner(db, novel_id, params, parsed)
    if agent_name == "critic":
        return _persist_critic(db, novel_id, params, parsed)
    if agent_name == "blueprint_architect":
        return _persist_blueprint(db, novel_id, parsed, params)
    if agent_name == "setting_extractor":
        return _persist_concept(db, novel_id, parsed)
    if agent_name == "memory_keeper":
        return _persist_memory_keeper(db, novel_id, params, parsed)
    if agent_name == "era_researcher":
        return _persist_era_research(db, novel_id, parsed)
    return {"action": "deferred", "detail": f"agent={agent_name} 的入库逻辑未启用"}


def _chain_tip_active(
    db: Session,
    novel_id: uuid.UUID,
    source: str,
    target: str,
    superseded_by_relation: Optional[str],
    superseded_by_chapter: Optional[int],
    pending_ids: set[uuid.UUID],
) -> bool:
    """沿取代链按「行」上溯：取代者行仍存在且有效则返回 True（不恢复）。

    取代链按行追踪：取代者 = 与 (source, target) 相同、关系为 superseded_by_relation、
    章节为 superseded_by_chapter 的那一行。同三元组不同章节是不同行，
    不会混淆（朋友1、2、3章 ≠ 朋友7章）。

    取代链示例：仇人(1,3) → 朋友(4) → 恋人(7)（恋人取代朋友，朋友取代仇人）。
    - 恋人行还有效（或本轮将恢复）→ 整条链存活，仇人、朋友都不能恢复。
    - 恋人行被重写删除 → 链条断裂，朋友可恢复；朋友恢复后仇人仍保持被取代。
    - 朋友(1,2,3) → 仇人(4) → 朋友(7)：重置第7章后，朋友(7) 行消失，
      仇人(4) 恢复；朋友(1,2,3) 因取代者仇人(4) 仍有效而保持被取代。

    pending_ids：本校准轮中「即将恢复」的行集合，恢复后即为有效行，
    判定时视为有效，保证「先恢复的中间层能阻止下游误恢复」。
    """
    if superseded_by_relation is None or superseded_by_chapter is None:
        return False
    seen: set[tuple[str, int]] = set()
    rel: Optional[str] = superseded_by_relation
    ch: Optional[int] = superseded_by_chapter
    while rel is not None and ch is not None and (rel, ch) not in seen:
        seen.add((rel, ch))
        superseder = db.query(EntityRelation).filter(
            EntityRelation.novel_id == novel_id,
            EntityRelation.source == source,
            EntityRelation.target == target,
            EntityRelation.relation == rel,
            EntityRelation.chapter_no == ch,
        ).first()
        if superseder is None:
            return False  # 取代者行不存在（被重写删除）→ 链断
        if superseder.id in pending_ids:
            return True  # 取代者本轮将恢复 → 链存活
        if not superseder.archived:
            return True  # 取代者有效 → 链存活
        # 取代者本身也被取代 → 沿它的 superseded_by 继续上溯；上溯到头仍全是已取代 → 链断
        rel = superseder.superseded_by_relation
        ch = superseder.superseded_by_chapter
    return False


def _reconcile_superseded(db: Session, novel_id: uuid.UUID) -> int:
    """一致性校准：恢复「取代链已断」的被取代关系，返回恢复行数。

    每章持久化后运行。pending_ids 循环把「将恢复的行」视为有效参与判定，
    直到稳定（无增减）才批量恢复；外层循环处理恢复引发的连带效应，
    保证「多副本删一个不回退、多层递进逐层回退、同名不同章不混淆」。
    """
    total = 0
    while True:
        targets = db.query(EntityRelation).filter(
            EntityRelation.novel_id == novel_id,
            EntityRelation.archived.is_(True),
            EntityRelation.superseded_by_relation.isnot(None),
        ).all()
        if not targets:
            return total
        pending_ids: set[uuid.UUID] = set()
        while True:
            changed = False
            for r in targets:
                if _chain_tip_active(
                    db, novel_id, r.source, r.target,
                    r.superseded_by_relation, r.superseded_by_chapter, pending_ids,
                ):
                    if r.id in pending_ids:
                        pending_ids.remove(r.id)
                        changed = True
                else:
                    if r.id not in pending_ids:
                        pending_ids.add(r.id)
                        changed = True
            if not changed:
                break
        if not pending_ids:
            return total
        db.query(EntityRelation).filter(EntityRelation.id.in_(pending_ids)).update(
            {"archived": False, "superseded_by_chapter": None, "superseded_by_relation": None}
        )
        db.commit()
        total += len(pending_ids)


def _persist_extractor(db: Session, novel_id: uuid.UUID, params: dict, parsed: BaseModel) -> dict:
    from app.schemas.agents import StoryStateExtract

    assert isinstance(parsed, StoryStateExtract)
    chapter_no = params.get("chapter_no")
    if chapter_no is None:
        return {"action": "deferred", "detail": "缺少 chapter_no，跳过入库"}
    # 幂等：同 (novel, chapter_no) 覆盖旧快照
    db.query(StoryState).filter(
        StoryState.novel_id == novel_id, StoryState.chapter_no == chapter_no
    ).delete()
    # 记录提取时对应的正文版本：取该章当前激活版本（提取的正文就是激活版本正文）
    chapter_version_id = None
    chapter = db.execute(
        select(Chapter).where(
            Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no
        )
    ).scalar_one_or_none()
    if chapter is not None:
        chapter_version_id = db.execute(
            select(ChapterVersion.id).where(
                ChapterVersion.chapter_id == chapter.id,
                ChapterVersion.is_active.is_(True),
            )
        ).scalar_one_or_none()
    row = StoryState(
        novel_id=novel_id,
        chapter_no=chapter_no,
        chapter_version_id=chapter_version_id,
        summary=parsed.summary,
        key_events=[e.model_dump() for e in parsed.key_events],
        character_states=[e.model_dump() for e in parsed.character_states],
        world_state_changes=[e.model_dump() for e in parsed.world_state_changes],
        new_foreshadowing=[e.model_dump() for e in parsed.new_foreshadowing],
        # ResolvedForeshadowing.ledger_id 是 UUID 对象，直接 model_dump() 会残留 UUID 对象，
        # SQLAlchemy JSON 列用 json.dumps 序列化时抛 "Object of type UUID is not JSON serializable"
        # → 提取落库必失败（已实测 TypeError）。显式转 str 再入库，与账本前端展示的字符串 id 一致。
        resolved_foreshadowing=[{"ledger_id": str(e.ledger_id)} for e in parsed.resolved_foreshadowing],
        unresolved_hooks=[e.model_dump() for e in parsed.unresolved_hooks],
        next_chapter_implications=parsed.next_chapter_implications,
    )
    db.add(row)
    db.commit()

    # 实体关系回填（M4：dynamic 剧情层）
    # 重提取时：先清理本章此前产生的动态关系，再写入新关系，
    # 避免切换版本/修订后旧版本遗留的过期关系残留。
    # 跨章不做去重：相同 (source, relation, target) 每章独立入库，
    # 由展示/注入层去重取最早一条，保证某章被改写不影响其他章确认过的事实。
    # ── 删除前快照：收集本章旧行里「被取代过的链条中间环」（archived 且 superseded_by 非空），
    #    用于检测「根部关系被改 → 后续章受影响」：如 师徒(1) 被 叛出师门(2) 取代、又被 死敌(3) 取代，
    #    作者删除/替换第1章关系时，第2、3章的递进前提就断了，前端据此提示作者重新提取对齐。
    #    先抽成普通元组（bulk delete + commit 会让 ORM 对象过期），删除后再沿链下行收集受影响的章号。
    old_chain_seeds = [
        (r.source, r.target, r.relation, r.superseded_by_relation, r.superseded_by_chapter)
        for r in db.query(EntityRelation).filter(
            EntityRelation.novel_id == novel_id,
            EntityRelation.chapter_no == chapter_no,
            EntityRelation.type == "dynamic",
        ).all()
        if r.archived and r.superseded_by_relation is not None and r.superseded_by_chapter is not None
    ]
    db.query(EntityRelation).filter(
        EntityRelation.novel_id == novel_id,
        EntityRelation.chapter_no == chapter_no,
        EntityRelation.type == "dynamic",
    ).delete()
    db.commit()
    # 先写入本章新关系（同章同三元组去重），再执行取代标记：
    # 取代者行 = 本章新关系行，用 (source, relation, target, chapter_no) 精确定位，
    # 这样取代链按「行」追踪，同三元组不同章节不会混淆（朋友1、2、3章 ≠ 朋友7章）。
    added = 0
    seen: set[tuple[str, str, str]] = set()
    for rel in parsed.relations:
        key = (rel.source, rel.target, rel.relation)
        # 同批内重复（未 flush 时查询不到已 add 的行）也要去重
        if key in seen:
            continue
        seen.add(key)
        db.add(
            EntityRelation(
                novel_id=novel_id,
                source=rel.source,
                target=rel.target,
                relation=rel.relation,
                type="dynamic",
                chapter_no=chapter_no,
                chapter_version_id=chapter_version_id,  # 记录提取时激活的正文版本，注入按版本过滤
                confidence=rel.confidence,
            )
        )
        added += 1
    if added:
        db.commit()
    # 取代关系自动标记失效：提取师识别出旧关系被新关系取代（师徒→叛出师门）时，
    # 把旧关系 archived=True（跨章统一失效），AI 注入跳过、展示灰显保留历史；
    # 同时记录取代者所在章与取代者关系名，供一致性校准回退（取代者行消失才恢复）。
    archived_superseded = 0
    for sup in parsed.superseded_relations:
        # 取代者关系名：优先用 AI 指名的 superseded_by（必须是本章同 source/target 的关系）；
        # 缺省则兜底取「同 (source, target) 的第一条新关系」（旧逻辑，仅当该对实体本章只新增一条新关系时准确）。
        superseder_rel = None
        if sup.superseded_by:
            for rel in parsed.relations:
                if rel.source == sup.source and rel.target == sup.target and rel.relation == sup.superseded_by:
                    superseder_rel = rel.relation
                    break
        if superseder_rel is None:
            for rel in parsed.relations:
                if rel.source == sup.source and rel.target == sup.target and rel.relation != sup.relation:
                    superseder_rel = rel.relation
                    break
        hit = db.query(EntityRelation).filter(
            EntityRelation.novel_id == novel_id,
            EntityRelation.source == sup.source,
            EntityRelation.target == sup.target,
            EntityRelation.relation == sup.relation,
            EntityRelation.archived.is_(False),
        ).update(
            {
                "archived": True,
                "superseded_by_chapter": chapter_no,
                "superseded_by_relation": superseder_rel,
                # 取代者提取时所在的正文版本：切回旧版本（该版本不激活）时，
                # 注入/展示层据此「复活」被取代的旧关系，消除取代链跨版本空档。
                "superseded_by_version": chapter_version_id,
            }
        )
        archived_superseded += hit
    if archived_superseded:
        db.commit()

    # 一致性校准：取代链（取代者及其后续取代者）全部消失时，回退恢复被取代的旧关系，
    # 实现「删除最新递进关系即回退到上一状态」：多副本删一个不回退、多层递进逐层回退。
    restored = _reconcile_superseded(db, novel_id)

    # 实体细节回写（首次提及即冻结）：正文写死的实体硬事实回写设定卡。
    # 冻结语义：hard_facts 已有键不被覆盖——后来者不得推翻最早确立的说法；
    # 之后章节会被 entity_checker 用冻结值确定性核对，正文若矛盾即告警（要求先改设定）。
    freeze_updated = 0
    if parsed.entity_detail_updates:
        for upd in parsed.entity_detail_updates:
            ent = (upd.entity or "").strip()
            if not ent:
                continue
            facts = upd.facts or {}
            if not isinstance(facts, dict) or not any(v not in (None, "") for v in facts.values()):
                continue
            row = _find_entity_setting(db, novel_id, ent)
            if row is None:
                continue  # 不在设定库的实体不自动建卡（防同名/变体污染），只回写已有卡
            st = dict(row.structured or {})
            hard = dict(st.get("hard_facts") or {})
            locked = list(st.get("locked_details") or [])
            changed = False
            evidence = (upd.source or "").strip()
            for k, v in facts.items():
                key = str(k).strip()
                val = str(v).strip()
                if not key or not val or key in hard:
                    continue  # 冻结：已有定档值不被覆盖
                hard[key] = val
                changed = True
            if evidence and evidence not in locked:
                locked.append(evidence)
                changed = True
            if changed:
                st["hard_facts"] = hard
                st["locked_details"] = locked
                row.structured = st
                freeze_updated += 1
    if freeze_updated:
        db.commit()

    # 根部编辑检测：本次重提取清掉了「被取代过的链条中间环」（如第1章的 师徒），
    # 顺取代链下行收集受影响的后续章节（师徒→叛出师门(2)→死敌(3) → 影响 [2,3]），
    # 返回给前端提示「这些章的递进前提已变更，是否重新提取对齐」。只提示，不改数据。
    # 每项带关系信息（源/目标/该章受影响的关系/根因章与根因关系），前端据此展示「是什么影响到了这章」。
    affected_chapters: list[dict] = []
    for src, tgt, origin_rel, sby_rel, sby_ch in old_chain_seeds:
        seen: set[tuple[str, int]] = set()
        rel: Optional[str] = sby_rel
        ch: Optional[int] = sby_ch
        while rel is not None and ch is not None and (rel, ch) not in seen:
            seen.add((rel, ch))
            if ch != chapter_no:
                affected_chapters.append(
                    {
                        "chapter_no": ch,
                        "source": src,
                        "target": tgt,
                        "relation": rel,  # 该章受影响的关系（如 叛出师门 / 死敌）
                        "origin_chapter": chapter_no,  # 根因章（本次被重提取的章）
                        "origin_relation": origin_rel,  # 根因关系（如 师徒），被删/改后断裂
                    }
                )
            # 取代者行若也被取代，继续下行走
            superseder = db.query(EntityRelation).filter(
                EntityRelation.novel_id == novel_id,
                EntityRelation.source == src,
                EntityRelation.target == tgt,
                EntityRelation.relation == rel,
                EntityRelation.chapter_no == ch,
            ).first()
            if superseder is None or not superseder.archived:
                break
            rel = superseder.superseded_by_relation
            ch = superseder.superseded_by_chapter

    return {
        "action": "persisted",
        "table": "story_state",
        "chapter_no": chapter_no,
        "relations_added": added,
        "relations_archived": archived_superseded,
        "relations_restored": restored,
        "entity_facts_frozen": freeze_updated,
        "downstream_affected": affected_chapters,
    }


def _find_entity_setting(db: Session, novel_id: uuid.UUID, ent: str) -> Optional[Setting]:
    """定位实体卡：先精确（name/aliases），再模糊（双向子串，取最长匹配）兜底。

    找不到返回 None（提取师回写只在已有设定卡上发生，不自动建卡）。
    """
    rows = list(
        db.execute(
            select(Setting).where(Setting.novel_id == novel_id, Setting.deleted_at.is_(None))
        ).scalars()
    )
    for r in rows:
        if r.name == ent:
            return r
        if ent in [str(a) for a in (r.aliases or [])]:
            return r
    best = None
    for r in rows:
        if ent in r.name or r.name in ent:
            if best is None or len(r.name) > len(best.name):
                best = r
    return best


def _persist_novelist(
    db: Session,
    novel_id: uuid.UUID,
    params: dict,
    parsed: BaseModel,
    source: Optional[str],
) -> dict:
    """小说家落库：chapters 行（无则建）+ chapter_versions 版本行。

    草稿追加模式：生成只追加一个 is_active=False 的草稿版本（版本级 title/outline_id），
    不激活、不写章级正文/状态。章保持 draft，直到手动定稿（select_version）才激活并同步章。
    """
    from app.schemas.agents import NovelChapter

    assert isinstance(parsed, NovelChapter)
    chapter_no = params.get("chapter_no")
    if chapter_no is None:
        last = db.execute(
            select(func.max(Chapter.chapter_no)).where(Chapter.novel_id == novel_id)
        ).scalar()
        chapter_no = (last or 0) + 1

    chapter = db.execute(
        select(Chapter).where(Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no)
    ).scalar_one_or_none()
    if chapter is None:
        chapter = Chapter(
            novel_id=novel_id,
            chapter_no=chapter_no,
            title=params.get("title"),
            status="draft",
        )
        db.add(chapter)
        db.flush()

    last_ver = db.execute(
        select(func.max(ChapterVersion.version_no)).where(ChapterVersion.chapter_id == chapter.id)
    ).scalar() or 0

    # 草稿追加：新版本 is_active=False，不动其他版本激活状态、不动章级正文/状态。
    # 标题与大纲版本关联精确到版本：生成时记到版本行，定稿时由 select_version 同步回章。
    # 版本树：新增/重新生成不传 parent_version_id=根；评价优化（reviser）传被优化版本 id=子节点。
    outline_id = params.get("outline_id")
    parent_version_id = params.get("parent_version_id")
    # 来源区分版本类型：新增章节=novelist（初稿）；重新生成正文=regenerate（再稿）；
    # 评价优化=reviser（修订稿）。前端据此显示版本名，并在版本树里区分层级。
    ver_source = source or "novelist"
    if params.get("regenerate"):
        ver_source = "regenerate"

    # 章节标题规则：
    # - 修订稿（reviser）：优化不是重写，标题必须沿用被优化版本/章节原标题，忽略 AI 输出的 title
    #   （AI 偶尔会把小说名当章节标题输出，导致修订稿标题变成书名）
    # - 新增/重新生成：用 AI 生成的标题，但标题不能等于小说名（同源兜底），否则回退到原标题
    title = params.get("title") or getattr(parsed, "title", None) or chapter.title
    if ver_source == "reviser":
        # parent_version_id 来自前端 JSON 参数，是字符串；Uuid 列绑定时不能直接传字符串
        # （SQLAlchemy 会报 "'str' object has no attribute 'hex'" 导致修订落库崩溃），先转 UUID。
        parent = None
        if parent_version_id is not None:
            try:
                parent = db.get(ChapterVersion, uuid.UUID(str(parent_version_id)))
            except (ValueError, TypeError):
                parent = None
        base_title = (parent.title if parent else None) or chapter.title
        # 评价优化默认沿用被优化版本标题；仅当 AI 判定「原标题与正文严重不符」且给出新标题时换题。
        # 守卫（防老 bug：AI 把小说名当章节标题输出）：新标题非空、不等于原名、不等于小说名才采用。
        ai_title = (getattr(parsed, "title", None) or "").strip()
        novel_row = db.get(Novel, novel_id)
        novel_title = novel_row.title if novel_row else None
        if (
            ai_title
            and ai_title != base_title
            and (not novel_title or ai_title != novel_title.strip())
        ):
            title = ai_title
        else:
            title = base_title
    else:
        novel_row = db.get(Novel, novel_id)
        novel_title = novel_row.title if novel_row else None
        if novel_title and title and title.strip() == novel_title.strip():
            title = chapter.title
    db.add(ChapterVersion(
        chapter_id=chapter.id,
        version_no=last_ver + 1,
        source=ver_source,
        title=title,
        content=parsed.content,
        note=parsed.note,
        outline_id=uuid.UUID(str(outline_id)) if outline_id is not None else None,
        parent_version_id=uuid.UUID(str(parent_version_id)) if parent_version_id is not None else None,
        is_active=False,
    ))
    db.commit()
    # 账本不在成稿时登记：伏笔动作改由「大纲批准」时进入账本（draft 不生效，与设定同语义）
    return {
        "action": "persisted",
        "table": "chapter_versions",
        "chapter_no": chapter_no,
        "source": source,
        # 写后自检：命中即回传，由 SSE 以 setting_warning 事件告警给前端
        "setting_warnings": _check_setting_gaps(db, novel_id, parsed.content),
    }


def _check_setting_gaps(db: Session, novel_id: uuid.UUID, content: str) -> list[dict]:
    """写后确定性自检：正文是否漏写了「必现清单」里的成员、是否与实体硬事实冲突。

    与评审阶段用的是同一套核对器（app.services.setting_checker / entity_checker）：
    那一侧拦的是"评不出来"，这一侧拦的是"写的时候就没写/写错了"。
    """
    try:
        from app.agents.context import (
            derive_stage,
            filter_settings_for_chapter,
            get_active_blueprint,
            get_settings_snapshot,
        )
        from app.services.setting_checker import check_chapter

        blueprint = get_active_blueprint(db, novel_id)
        bp_content = blueprint.content if hasattr(blueprint, "content") else blueprint
        all_settings = get_settings_snapshot(db, novel_id)
        items = check_chapter(db, novel_id, content or "", bp_content, all_settings)
        # 实体硬事实核对（机构成立时间/量级等，与必现清单共用同一条 setting_warning 通道）
        try:
            from app.services.entity_checker import (
                check_entity_facts,
                check_org_archive_gaps,
                extract_entity_facts,
            )

            items = items + check_entity_facts(content or "", extract_entity_facts(all_settings))
            # 机构档案维度核对：正文出现的机构若档案缺负责人/规模/业务/位置等，提示补齐
            items = items + check_org_archive_gaps(content or "", all_settings)
        except Exception:
            logger.exception("实体硬事实写后自检失败（不影响成文）")
        return items
    except Exception:
        logger.exception("设定写后自检失败（不影响成文）")
        return []


def _persist_outliner(
    db: Session, novel_id: uuid.UUID, params: dict, parsed: BaseModel
) -> dict:
    """大纲师落库：outlines(draft)。账本不在大纲生成时维护——草稿章不碰账本，
    章节成稿时由 sync_ledger_from_outline 从该章大纲统一登记伏笔动作。

    版本语义：同一章可存多个版本，新大纲按 (chapter_no) 最大 version_no + 1 插入，
    不覆盖删除旧版（轻量历史版本，用户可回看/切换）。批准版是下游唯一依据。

    章号权威性：用户在前端明确选择/锁定的 chapter_no 是落库章号，AI 自报的
    chapter.no 仅作参考。若两者不符（模型把目标章号当成了别的章，如续写最近一章），
    强制以用户选择为准，避免大纲落进用户没有要求的章节。
    """
    from app.db.models import Outline
    from app.schemas.agents import ChapterOutline

    assert isinstance(parsed, ChapterOutline)
    ch = parsed.chapter
    requested: Optional[int] = None
    if params:
        try:
            requested = int(params.get("chapter_no"))
        except (TypeError, ValueError):
            requested = None
    chapter_no = ch.no
    if requested and requested > 0:
        if ch.no != requested:
            logger.warning(
                "outliner 章号纠正：AI 输出 no=%s，用户要求 chapter_no=%s，以用户选择为准",
                ch.no,
                requested,
            )
        ch.no = requested  # content 序列化时同步带出正确章号
        chapter_no = requested

    # 同章已有版本数 → 新版本号 +1（无历史版本时从 1 开始）
    max_ver = (
        db.query(func.max(Outline.version_no))
        .filter(Outline.novel_id == novel_id, Outline.chapter_no == chapter_no)
        .scalar()
    )
    version_no = (max_ver or 0) + 1
    row = Outline(
        novel_id=novel_id,
        chapter_no=chapter_no,
        version_no=version_no,
        title=ch.title,
        content=ch.model_dump(mode="json"),  # mode=json：UUID → str，适配 JSON 列
        status="draft",
    )
    db.add(row)
    db.flush()  # 取回新大纲 id（供 stored 事件携带，前端可精确选中新版本）
    new_id = str(row.id)
    db.commit()
    return {"action": "persisted", "table": "outlines", "chapter_no": chapter_no, "version_no": version_no, "id": new_id}


def persist_chapter_plan(
    db: Session,
    novel_id: uuid.UUID,
    chapter_no: int,
    plan: dict,
) -> uuid.UUID:
    """正文前置规划确认后落库：把「本章规划」存为 approved 大纲（轻量版）。

    规划即大纲（合并方案）：规划只含 novelist 真正依赖的结构信息（标题/目标/节奏功能/
    视角/节拍/结尾钩子），作者在弹窗确认后直接落库为 approved outline，下游
    （critic 评价对照、记忆层、outlineHasChapter 检查、账本）无需改动即可复用。

    版本语义：与 _persist_outliner 一致，同一章可存多个版本，规划确认插入新版本
    （version_no=max+1）；同章其他 approved 版降回 draft（批准版是下游唯一依据）。
    节拍存成 outline.beats（content 字段），供 _summarize_outline 对照评价。
    账本不在此登记：规划不含伏笔动作，正文写完后由提取师维护账本。
    """
    from app.db.models import Outline

    max_ver = (
        db.query(func.max(Outline.version_no))
        .filter(Outline.novel_id == novel_id, Outline.chapter_no == chapter_no)
        .scalar()
    )
    version_no = (max_ver or 0) + 1
    beats = [
        {
            "beat_no": i + 1,
            "type": "scene",
            "pov": plan.get("pov", ""),
            "content": b,
            "length_hint": "",
            "emotion": "",
        }
        for i, b in enumerate(plan.get("beats") or [])
        if isinstance(b, str) and b.strip()
    ]
    row = Outline(
        novel_id=novel_id,
        chapter_no=chapter_no,
        version_no=version_no,
        title=plan.get("title"),
        content={
            "goal": plan.get("goal", ""),
            "chapter_function": plan.get("chapter_function", "progression"),
            "pov": plan.get("pov", ""),
            "beats": beats,
            "ending_hook": plan.get("ending_hook", ""),
            "characters": [],
            "locations": [],
            "conflicts": [],
            "plant_foreshadowing": [],
            "resolve_foreshadowing": [],
            "thread_updates": [],
        },
        status="approved",
    )
    # 同章其他 approved 降回 draft（批准版唯一）
    db.query(Outline).filter(
        Outline.novel_id == novel_id,
        Outline.chapter_no == chapter_no,
        Outline.id != row.id,
        Outline.status == "approved",
    ).update({"status": "draft"})
    db.add(row)
    db.flush()
    new_id = row.id
    db.commit()
    return new_id


def sync_ledger_from_outline(
    db: Session,
    novel_id: uuid.UUID,
    chapter_no: int,
    outline_id: Optional[uuid.UUID] = None,
) -> None:
    """章节批准时登记账本：从该章大纲提取伏笔动作（plant/resolve/thread）重算账本贡献。

    覆盖语义：不再物理删除旧版本行，新版本 plant/thread 行（带当前 outline_id）直接登记；
    旧版本行保留，读取侧只显示「来源版本仍批准」的行，旧版降 draft 后自动隐藏、
    重新批准旧版即恢复——与设定/账本「切回即恢复」一致（避免批准新版后旧版本账本数据被物理删除、无法恢复）。
    resolve（回收）若命中旧版来源的行，将其迁移到当前版本再标 closed，保证回收结论在当前版本下可见。
    该章无大纲时不登记。

    大纲来源的账本行带 source="outline" + outline_id（来源版本，隐形字段不展示）：
    列表/上下文只显示「来源版本仍批准」的行，切版本后隐藏（不删除，切回恢复）。

    outline_id 提供时（批准流程）直接用该版本重算（此时尚未置 approved 也可）；
    缺省回退到「批准版优先，无则最新版」的查询。
    """
    from app.db.models import Outline

    outline = None
    if outline_id is not None:
        outline = db.get(Outline, outline_id)
        if outline is not None and outline.novel_id != novel_id:
            outline = None
    if outline is None:
        # 同一章可能有多个版本（轻量历史版本）：账本只认「批准版」；
        # 该章还没有批准版时，退回最新一版（避免多版本时 scalar_one_or_none 报错）。
        outline = db.execute(
            select(Outline)
            .where(
                Outline.novel_id == novel_id,
                Outline.chapter_no == chapter_no,
                Outline.status == "approved",
            )
            .order_by(Outline.version_no.desc())
        ).scalars().first()
    if outline is None:
        outline = db.execute(
            select(Outline)
            .where(Outline.novel_id == novel_id, Outline.chapter_no == chapter_no)
            .order_by(Outline.version_no.desc())
        ).scalars().first()
    if outline is None:
        return  # 该章没有大纲，无可登记

    content = outline.content or {}
    plant = content.get("plant_foreshadowing") or []
    thread = content.get("thread_updates") or []
    resolve = content.get("resolve_foreshadowing") or []

    # 版本化登记：不删旧版本行、不重置上一版「本章已回收」标记（旧版行保留其 outline_id，
    # 读取侧按「来源版本仍批准」过滤——旧版降 draft 自动隐藏，重新批准旧版即恢复）。
    # 这样切回旧大纲版本时，其账本行仍存在可恢复，不会因批准新版被物理删除。
    for p in plant:
        db.add(PlotLedger(
            novel_id=novel_id,
            item_type="setup",
            description=p.get("desc", ""),
            chapter_introduced=chapter_no,
            target_reveal_chapter=p.get("latest_payoff_chapter"),
            status="open",
            confidence="high",
            source="outline",
            outline_id=outline.id,
            # 关键信息固化（C）：跨多章/主线关键的伏笔 importance=high → 固化，账本超 20 条也不被挤出
            is_pinned=(str(p.get("importance", "")).lower() == "high"),
        ))
    for t in thread:
        db.add(PlotLedger(
            novel_id=novel_id,
            item_type="thread",
            description=f"线索「{t.get('thread', '')}」→ {t.get('new_state', '')}",
            related_entity=t.get("thread"),
            chapter_introduced=chapter_no,
            status="open",
            confidence="high",
            source="outline",
            outline_id=outline.id,
        ))
    for r in resolve:
        try:
            rid = uuid.UUID(str(r.get("ledger_id")))
        except (TypeError, ValueError):
            continue  # 非法 id 直接跳过，不回收
        row = db.get(PlotLedger, rid)
        if row is not None and row.novel_id == novel_id and row.status == "open":
            # 目标行若属于已降 draft 的旧版大纲（当前不可见），新版「接续回收」这条伏笔：
            # 把行迁移到当前版本再标 closed，保证回收结论在当前版本下可见；manual 行保留原来源。
            if row.source == "outline" and row.outline_id is not None and row.outline_id != outline.id:
                row.outline_id = outline.id
            row.status = "closed"
            row.chapter_resolved = chapter_no
    db.commit()


def _persist_critic(db: Session, novel_id: uuid.UUID, params: dict, parsed: BaseModel) -> dict:
    """评价师落库：quality_reviews（§5.6）。chapter_version_id 缺省取该章 active 版本。

    落库后重算该正文版本的签约未过签标记（signing_blocked）：最新评价含 severity=high 的
    红线类 issue（内容红线/抄袭，见 PLATFORM_SIGNING_REVIEW）→ 标记 True，定稿默认拒绝；
    通过 → 自动解除。评价更新即重算，不依赖作者手动操作。
    """
    from app.db.models import QualityReview
    from app.schemas.agents import ReviewOutput

    assert isinstance(parsed, ReviewOutput)
    chapter_version_id = params.get("chapter_version_id")
    if chapter_version_id is not None:
        chapter_version_id = uuid.UUID(str(chapter_version_id))
    if chapter_version_id is None and params.get("chapter_no") is not None:
        chapter = db.execute(
            select(Chapter).where(
                Chapter.novel_id == novel_id, Chapter.chapter_no == params["chapter_no"]
            )
        ).scalar_one_or_none()
        if chapter is not None:
            active = db.execute(
                select(ChapterVersion).where(
                    ChapterVersion.chapter_id == chapter.id, ChapterVersion.is_active.is_(True)
                )
            ).scalar_one_or_none()
            chapter_version_id = active.id if active else None

    review = QualityReview(
        novel_id=novel_id,
        chapter_version_id=chapter_version_id,
        overall_score=parsed.overall_score,
        rubric=parsed.rubric.model_dump(),
        issues=[i.model_dump() for i in parsed.issues],
        strengths=parsed.strengths,
        revision_hints=parsed.revision_hints,
    )
    db.add(review)
    # 签约未过签标记：最新评价存在 severity=high 的红线 issue → 该版本未过签
    signing_blocked = any((i.severity or "").lower() == "high" for i in parsed.issues)
    if chapter_version_id is not None:
        ver = db.get(ChapterVersion, chapter_version_id)
        if ver is not None and ver.signing_blocked != signing_blocked:
            ver.signing_blocked = signing_blocked
    db.commit()
    db.refresh(review)
    return {
        "action": "persisted",
        "table": "quality_reviews",
        "id": str(review.id),
        "chapter_no": params.get("chapter_no"),
        "overall_score": parsed.overall_score,
        "rubric": parsed.rubric.model_dump(),
        "issues": [i.model_dump() for i in parsed.issues],
        "strengths": parsed.strengths,
        "revision_hints": parsed.revision_hints,
        "signing_blocked": signing_blocked,
    }


def sync_active_blueprint_style(db: Session, novel_id: uuid.UUID, blueprint_id: uuid.UUID) -> None:
    """全局文风跟随生效蓝图：把 novel.style_directive 同步为该蓝图版本提炼的文风（无则清空）。

    手动文风（style_directive_manual）不受影响。仅激活切换时调用（新增蓝图一律未生效，
    不会自动注入文风），保证「切到哪版蓝图，写作就用哪版的文风」。
    """
    from app.db.models import BlueprintStyle

    novel = db.get(Novel, novel_id)
    if novel is None:
        return
    st = db.execute(
        select(BlueprintStyle).where(BlueprintStyle.blueprint_id == blueprint_id).limit(1)
    ).scalar_one_or_none()
    directive = (st.directive or "").strip() if st else ""
    novel.style_directive = directive or None
    db.commit()


def _persist_blueprint(
    db: Session, novel_id: uuid.UUID, parsed: BaseModel, params: Optional[dict] = None
) -> dict:
    """蓝图师落库：blueprints（版本链，§5.2）。

    - version = 已有最大版本 + 1；parent_id 指向上一版。
    - 状态机（两态：active 生效中 | inactive 未生效）：
      · 新蓝图一律 inactive，不自动生效；由用户手动点「设为生效中」激活。
      · 激活时才把该蓝图内容注入其他功能页面（文风同步、设定按版本展示、写作/大纲读 active 蓝图），
        新增/生成蓝图不会自动注入。
    - 导入模式：把导入文档全文 + 文件名一并存入该版本（source_doc/doc_name），
      供「导入后自动校验比对」与溯源使用；设定/文风在「设为生效中」时按版本抽取，激活后随蓝图一起生效。
    """
    from app.db.models import Blueprint

    from app.schemas.agents import Blueprint as BlueprintSchema

    assert isinstance(parsed, BlueprintSchema)
    last = db.execute(
        select(Blueprint).where(Blueprint.novel_id == novel_id).order_by(Blueprint.version.desc()).limit(1)
    ).scalar_one_or_none()
    version = (last.version if last else 0) + 1

    params = params or {}
    source_doc = (params.get("import_source") or "").strip() or None

    # 导入模式：书名保持手动维护，不再随导入文档自动改动（自动改名会覆盖作者维护的书名）。
    title_synced = False

    # 新增蓝图一律未生效（inactive）：想生效必须手动点「设为生效中」，
    # 避免新增/生成蓝图时自动把内容注入写作、大纲、设定等页面。
    status = "inactive"

    bp = Blueprint(
        novel_id=novel_id,
        version=version,
        parent_id=last.id if last else None,
        content=parsed.model_dump(mode="json"),
        source_doc=source_doc,
        doc_name=(params.get("doc_name") or None) if source_doc else None,
        status=status,
    )
    db.add(bp)
    db.commit()

    # 生成完成：把带版本号的完成文案写进任务 msg，供前端全局悬浮框提示
    # （"蓝图 vX 已生成完毕"）；stream 层的 _finish_task 在 done 时不会覆盖已有 msg。
    try:
        from app.db.models import AgentTask

        task = db.execute(
            select(AgentTask)
            .where(
                AgentTask.novel_id == novel_id,
                AgentTask.agent == "blueprint_architect",
                AgentTask.status == "running",
            )
            .order_by(AgentTask.created_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if task is not None:
            task.msg = f"蓝图 v{version} 已生成完毕"
            db.commit()
    except Exception:
        db.rollback()

    return {
        "action": "persisted",
        "table": "blueprints",
        "blueprint_id": str(bp.id),
        "version": version,
        "status": bp.status,
        "title_synced": title_synced,
        "title": parsed.title,
    }


def _persist_concept(db: Session, novel_id: uuid.UUID, parsed: BaseModel) -> dict:
    """概念师落库：concept_cards（pending，§5.1）。确认后由 /confirm 接口转正为 settings。"""
    from app.db.models import ConceptCard
    from app.schemas.agents import ConceptExtraction

    assert isinstance(parsed, ConceptExtraction)
    added = 0
    for c in parsed.concepts:
        # 幂等：同 novel 同 raw_quote 不重复沉淀
        exists = db.execute(
            select(ConceptCard.id).where(
                ConceptCard.novel_id == novel_id,
                ConceptCard.raw_text == c.raw_quote,
                ConceptCard.status.in_(["pending", "confirmed", "integrated"]),
            ).limit(1)
        ).scalar_one_or_none()
        if exists is not None:
            continue
        db.add(ConceptCard(
            novel_id=novel_id,
            raw_text=c.raw_quote,
            extracted=c.model_dump(mode="json"),
            status="pending",
        ))
        added += 1
    db.commit()
    return {"action": "persisted", "table": "concept_cards", "added": added}


def _persist_memory_keeper(db: Session, novel_id: uuid.UUID, params: dict, parsed: BaseModel) -> dict:
    """编年师落库：novel_memories（每 N 章生成一份，版本递增，旧版保留不覆盖）。

    覆盖到章节 = params.up_to_chapter（取最新已写章节号）。同 up_to_chapter 重复生成时
    直接覆盖（同章最新编年为准），版本号递增标记刷新次数。
    """
    from app.db.models import NovelMemory
    from app.schemas.agents import ChronicleOutput

    assert isinstance(parsed, ChronicleOutput)
    up_to = params.get("up_to_chapter")
    if up_to is None:
        last = db.execute(
            select(func.max(Chapter.chapter_no)).where(Chapter.novel_id == novel_id)
        ).scalar()
        up_to = last or 0
    # 同覆盖章节已有一份：版本递增并覆盖内容；否则新建 version=1
    row = db.execute(
        select(NovelMemory).where(
            NovelMemory.novel_id == novel_id, NovelMemory.up_to_chapter == up_to
        )
    ).scalar_one_or_none()
    if row is not None:
        row.version = row.version + 1
        row.content = parsed.model_dump(mode="json")
    else:
        db.add(NovelMemory(
            novel_id=novel_id,
            version=1,
            up_to_chapter=up_to,
            content=parsed.model_dump(mode="json"),
        ))
    db.commit()
    return {"action": "persisted", "table": "novel_memories", "up_to_chapter": up_to, "version": (row.version if row else 1)}


def _persist_era_research(db: Session, novel_id: uuid.UUID, parsed: BaseModel) -> dict:
    """时代行业研究员落库：覆盖写入 novel.era_research（作者可改，换书自动重研究）。"""
    from app.schemas.agents import EraResearch

    assert isinstance(parsed, EraResearch)
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise ValueError(f"小说不存在：{novel_id}")
    novel.era_research = parsed.model_dump(mode="json")
    db.commit()
    return {"action": "persisted", "table": "novels", "field": "era_research", "era": parsed.era, "industry": parsed.industry}


# ---------- 作者确认机制（生成流程内暂停点） ----------

# 等待作者确认时的轮询间隔（秒）
AUTHOR_CONFIRM_POLL_SECONDS = 2.0
# 单次确认等待上限（秒）：作者超过该时长未答复则自动 dismissed，生成任务用默认方向继续（不卡死）
AUTHOR_CONFIRM_TIMEOUT_SECONDS = 900

# 等待作者确认的时间不计入任务生成预算（见 stream.py 的 _ConfirmAwareTimeout）：
# 后台任务在生成前把「顺延 deadline 的回调」放进这里，request_author_confirmation 在
# 每次确认等待开始前把任务绝对超时 deadline 顺延（覆盖本轮等待上限 + 缓冲），等待结束后
# 按实际等待时长精确回退——确认等待相当于暂停了生成计时器。
# 否则确认等待会占用生成预算（era 确认等满 15 分钟自动跳过后，剩余预算不足以跑完
# 预检 + 蓝图师 → 20 分钟整被超时终止、蓝图无数据落库）。
_confirm_wait_extender: contextvars.ContextVar = contextvars.ContextVar(
    "_confirm_wait_extender", default=None
)


def set_confirm_wait_extender(extend) -> contextvars.Token:
    """注册「确认等待时顺延任务超时 deadline」的回调（后台任务层调用），返回恢复用 Token。"""
    return _confirm_wait_extender.set(extend)


def reset_confirm_wait_extender(token: contextvars.Token) -> None:
    """恢复上一个顺延回调（与 set_confirm_wait_extender 成对使用）。"""
    _confirm_wait_extender.reset(token)


def _confirm_to_dict(row, novel_titles: Optional[dict] = None) -> dict:
    """AuthorConfirm 行 → 前端可展示的确认对象（novel_titles 传 id→标题映射时附带小说名）。"""
    return {
        "id": str(row.id),
        "novel_id": str(row.novel_id),
        "novel_title": (novel_titles or {}).get(str(row.novel_id)),
        "agent": row.agent,
        "task_id": str(row.task_id) if row.task_id else None,
        "confirm_key": row.confirm_key,
        "status": row.status,
        "question": row.question,
        "options": row.options or [],
        "allow_custom": bool(row.allow_custom),
        "answer": row.answer,
        "answer_meta": row.answer_meta,
        "created_at": row.created_at.isoformat() + "Z" if row.created_at else None,
    }


def _novel_titles_map(db: Session, rows) -> dict:
    """批量取这些确认所属小说的标题（id→title），供跨小说通知展示书名。"""
    from app.db.models import Novel

    ids = {r.novel_id for r in rows if r.novel_id is not None}
    if not ids:
        return {}
    return {
        str(n.id): n.title
        for n in db.execute(select(Novel).where(Novel.id.in_(ids))).scalars()
    }


def get_pending_confirms(
    db: Session, novel_id: Optional[uuid.UUID] = None, agent: Optional[str] = None
) -> list[dict]:
    """查询 pending 状态的作者确认请求（前端弹窗/刷新恢复/跨小说通知用）。

    novel_id 缺省时返回所有小说的待确认项（全局确认提醒中心轮询用）；
    agent 传入时精确到角色（如前端只在大纲页/设置页展示对应确认点）。
    """
    from app.db.models import AuthorConfirm

    q = select(AuthorConfirm).where(AuthorConfirm.status == "pending")
    if novel_id is not None:
        q = q.where(AuthorConfirm.novel_id == novel_id)
    rows = [
        r
        for r in db.execute(q.order_by(AuthorConfirm.created_at)).scalars()
        if agent is None or r.agent == agent
    ]
    titles = _novel_titles_map(db, rows)
    return [_confirm_to_dict(r, titles) for r in rows]


def answer_author_confirm(
    db: Session, confirm_id: uuid.UUID, answer: str, note: Optional[str] = None
) -> dict:
    """作者提交确认答案：把 pending 置为 answered（生成任务轮询到后恢复）。

    选项命中时 answer 为选项 id，answer_meta 记录选中选项的 label + 作者补充说明；
    自定义输入时 answer 为作者原文。
    """
    from datetime import datetime, timezone

    from app.db.models import AuthorConfirm

    row = db.get(AuthorConfirm, confirm_id)
    if row is None:
        raise ValueError("确认请求不存在")
    if row.status != "pending":
        raise ValueError(f"确认请求已处理（{row.status}），不可重复提交")
    option = next((o for o in (row.options or []) if isinstance(o, dict) and o.get("id") == answer), None)
    row.status = "answered"
    row.answer = answer
    row.answer_meta = {
        "label": option.get("label") if option else None,
        "note": note or "",
    }
    row.answered_at = datetime.now(timezone.utc)
    db.commit()
    return _confirm_to_dict(row)


def dismiss_author_confirm(db: Session, confirm_id: uuid.UUID) -> dict:
    """作者主动跳过确认点：pending → dismissed（生成任务轮询到后按默认方向继续）。

    区别于超时：作者明确关闭弹窗=不想选择，任务立刻恢复，不占用完整等待窗口。
    """
    from app.db.models import AuthorConfirm

    row = db.get(AuthorConfirm, confirm_id)
    if row is None:
        raise ValueError("确认请求不存在")
    if row.status != "pending":
        raise ValueError(f"确认请求已处理（{row.status}），不可重复提交")
    row.status = "dismissed"
    row.answer = "__skip__"
    row.answer_meta = {"label": None, "note": "作者主动跳过"}
    db.commit()
    return _confirm_to_dict(row)


async def request_author_confirmation(
    db: Session,
    *,
    novel_id: uuid.UUID,
    task_id: Optional[uuid.UUID],
    agent: str,
    confirm_key: str,
    question: str,
    options: Optional[list[dict]] = None,
    allow_custom: bool = True,
    on_pending=None,
) -> dict:
    """请求作者确认并等待答复（阻塞轮询 DB，供生成任务在确认点暂停后恢复）。

    - 幂等：同 (novel_id, agent, confirm_key) 已有 pending → 不重复创建，直接等它；
      已 answered → 直接返回答案（同一确认点不会重复弹窗）。
    - on_pending(row_dict)：确认请求落库后同步回调。调用方用它把 SSE author_confirm
      事件塞进转发队列，让在线前端实时弹窗；刷新/断线用户靠 get_pending_confirms 轮询恢复。
    - 返回 {"status": "answered"|"dismissed"|"timeout",
             "answer": str|None, "option": dict|None, "note": str|None}
    """
    from app.db.models import AuthorConfirm

    # 幂等：同确认点已有记录，直接复用（防止同一任务重复创建确认请求/重复弹窗）
    row = db.execute(
        select(AuthorConfirm)
        .where(
            AuthorConfirm.novel_id == novel_id,
            AuthorConfirm.agent == agent,
            AuthorConfirm.confirm_key == confirm_key,
        )
        .order_by(AuthorConfirm.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if row is None:
        row = AuthorConfirm(
            novel_id=novel_id,
            agent=agent,
            task_id=task_id,
            confirm_key=confirm_key,
            status="pending",
            question=question,
            options=options or [],
            allow_custom=allow_custom,
        )
        db.add(row)
        db.commit()
        if on_pending is not None:
            try:
                on_pending(_confirm_to_dict(row))
            except Exception:
                logger.exception("作者确认 on_pending 回调失败（不影响等待）")

    if row.status == "answered":
        return _confirm_result(row)
    if row.status == "dismissed":
        return {"status": "dismissed", "answer": row.answer, "option": None, "note": (row.answer_meta or {}).get("note")}

    loop = asyncio.get_running_loop()
    deadline = loop.time() + AUTHOR_CONFIRM_TIMEOUT_SECONDS
    # 等作者确认的时间不计入任务生成预算：等待开始前顺延任务绝对超时 deadline
    #（覆盖本轮等待上限 + 缓冲），结束后按实际等待时长精确回退，见 _confirm_wait_extender。
    extend = _confirm_wait_extender.get()
    wait_started = loop.time()
    if extend is not None:
        try:
            extend(AUTHOR_CONFIRM_TIMEOUT_SECONDS + 60)
        except Exception:
            logger.exception("novel_id=%s agent=%s confirm_key=%s 确认等待 deadline 顺延失败（不影响等待）", novel_id, agent, confirm_key)
            extend = None  # 顺延失败则不再回退，保持原行为
    try:
        while True:
            # 强制从 DB 重新加载：POST /confirm 用的是另一个 session，identity map 会缓存旧状态
            try:
                db.refresh(row)
            except Exception:
                db.rollback()
                return {"status": "dismissed", "answer": None, "option": None, "note": None}
            if row.status == "answered":
                return _confirm_result(row)
            if row.status == "dismissed":
                return {"status": "dismissed", "answer": row.answer, "option": None, "note": (row.answer_meta or {}).get("note")}
            if loop.time() >= deadline:
                # 作者长时间未答复：自动 dismissed，任务用默认方向继续（不卡死后台任务）
                row.status = "dismissed"
                db.commit()
                logger.info("novel_id=%s agent=%s confirm_key=%s 作者确认等待超时，自动跳过", novel_id, agent, confirm_key)
                return {"status": "timeout", "answer": None, "option": None, "note": None}
            await asyncio.sleep(AUTHOR_CONFIRM_POLL_SECONDS)
    finally:
        if extend is not None:
            try:
                # 精确回退：deadline 最终只推进「实际等待作者」的时长（= 确认等待不占用生成预算）
                extend(-(AUTHOR_CONFIRM_TIMEOUT_SECONDS + 60 - (loop.time() - wait_started)))
            except Exception:
                logger.exception("novel_id=%s agent=%s confirm_key=%s 确认等待 deadline 回退失败（不影响结果）", novel_id, agent, confirm_key)


def _confirm_result(row) -> dict:
    """从已答复的确认行构造返回结果（供生成任务恢复后读取作者选择）。"""
    option = None
    if row.options:
        option = next((o for o in row.options if isinstance(o, dict) and o.get("id") == row.answer), None)
    return {
        "status": "answered",
        "answer": row.answer,
        "option": option,
        "note": (row.answer_meta or {}).get("note"),
    }


def commit_agent_output(
    db: Session,
    agent_name: str,
    novel_id: uuid.UUID,
    params: dict,
    output: dict,
    source: Optional[str] = None,
) -> dict:
    """把调试 dry_run 的产物显式加入正式库（复用各角色 _persist，不重新调用 AI）。

    output 为 dry_run 运行时 stored 事件返回的 data（单版本）或 versions[i].data（多版本）。
    """
    agent: Agent = get_agent(db, agent_name)
    parsed = agent.parse_output(json.dumps(output, ensure_ascii=False))
    return _persist(db, agent_name, novel_id, params, parsed, source=source)
