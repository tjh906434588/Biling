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
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.agents.base import Agent, ContextPack
from app.agents.registry import get_agent
from app.db.models import (
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
) -> AsyncIterator[str]:
    """通用流式生成入口：返回 SSE 格式文本流。自动识别单/多版本。

    dry_run=True：只生成不落库（调试沙箱），stored 事件携带产出，由用户决定是否
    通过 commit 接口显式加入正式库。
    """
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
            while True:
                async for ev in drain_reason():
                    yield ev
                if pump_done.is_set() and q.empty():
                    break
                try:
                    piece = await asyncio.wait_for(q.get(), timeout=SSE_KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    # 长思考期连接零字节闲置会被代理掐断：发 ping 保活，继续等（不取消生成器）
                    yield _event("ping", {})
                    continue
                text += piece
                yield _event("stream_delta", {"delta": piece})
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
        return
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
            return
        text = result[0]

    yield _event("stream_end", {"text_length": len(text)})

    if not text.strip():
        # 空输出重试耗尽：空文本不可能通过校验，跳过无意义的 schema 重试，直接按失败处理
        logger.error("agent=%s 连续 %d 次无正文输出，放弃", agent_name, MAX_EMPTY_RETRY + 1)
        yield _event("stream_error", {"message": "模型连续多次未输出内容，请稍后重试。"})
        return

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
            stored = _persist(db, agent_name, novel_id, params, parsed)
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

    try:
        agent = get_agent(db, "setting_extractor")
        ctx = agent.build_context(novel_id, {
            "text": params.get("import_source", ""),
            "doc_name": params.get("doc_name") or "导入的大纲文档",
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
        resolved_foreshadowing=[e.model_dump() for e in parsed.resolved_foreshadowing],
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
        "downstream_affected": affected_chapters,
    }


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
        parent = db.get(ChapterVersion, parent_version_id) if parent_version_id is not None else None
        title = (parent.title if parent else None) or chapter.title
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
    """写后确定性自检：正文是否漏写了「必现清单」里的成员。

    与评审阶段用的是同一套核对器（app.services.setting_checker）：那一侧拦的是
    "评不出来"，这一侧拦的是"写的时候就没写"。
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
        return check_chapter(db, novel_id, content or "", bp_content, all_settings)
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
    """评价师落库：quality_reviews（§5.6）。chapter_version_id 缺省取该章 active 版本。"""
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
