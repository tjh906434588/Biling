/**
 * @file outline-panel.tsx
 * 大纲页面板：大纲师逐章生成章节大纲（卷分组列表 / 详情 / 多版本切换），并支持批准注入与伏笔账本。
 * 核心机制：AI 生成走 SSE（runAgent）流式输出 + author_confirm 作者确认 + stored 落库标记；
 * 刷新/切页后用 getAgentRunningTask 轮询恢复进行中任务；批准注入用 1.5s 轮询（跨小说用 ref 隔离）；
 * 全程以 liveNovelRef + mountedRef 守卫，切页签/切小说后不误弹提示、不用旧结果刷新。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveOutline,
  friendlyRunError,
  friendlyTaskError,
  getActiveBlueprint,
  getAgentRunningTask,
  getOutlineApprovalStatus,
  getStreamStatus,
  listOutlines,
  listOutlineVersions,
  listSettings,
  outlineHasChapter,
  runAgent,
  type AgentRunningTaskResult,
  type AuthorConfirm,
  type Outline,
  type OutlineApprovalStatusResult,
  type Setting,
} from "@/lib/api";
import ConfirmDialog from "@/components/confirm-dialog";
import AgentStreamModal from "../components/agent-stream-modal";
import { pushAuthorConfirm } from "@/components/author-confirm";
import { useElapsed } from "@/lib/use-elapsed";
import { message } from "@/components/message";
import Loading from "@/components/loading";
import { useAiStatus } from "@/lib/ai-status";
import { type VolumeInfo } from "@/constants";
import OutlineList from "./components/outline-list";
import OutlineDetail from "./components/outline-detail";
import GenOutlineModal from "./components/gen-outline-modal";
import {
  deriveStage,
  groupByVolume,
  isCharacterActive,
  nextAutoChapterNo,
  EMPTY_FORM,
  type GenForm,
  type OutlineContent,
  type VolumeGroup,
} from "./components/outline-utils";

interface Props {
  novelId: string;
}

export default function OutlinePanel({ novelId }: Props) {
  // 组件实例被 App Router 跨小说复用：记录「当前正在显示的小说」，AI 流回调/收尾据此判断是否已切小说
  const liveNovelRef = useRef(novelId);
  useEffect(() => {
    liveNovelRef.current = novelId;
  }, [novelId]);
  /** 挂载标记：切页签会卸载本面板，但 runAgent 的流回调仍在后台继续。
   *  卸载后不再弹全局 Message（居中的成功/告警提示），避免「切到其他页面完成」时
   *  和全局右上角 Notification 重复弹两条；跨页的完成提醒由 agent-task-toasts 兜底。
   *  注意：必须「挂载时置 true、卸载时置 false」。若像以前那样初始 true 且只在卸载置 false，
   *  React StrictMode 开发模式的「挂载→模拟卸载→重新挂载」会把 ref 永久钉在 false，
   *  导致本面板所有 AI 流回调被守卫吞掉（生成弹窗只见占位文字、完成无提示、结果不刷新）。 */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 章节大纲列表（后端为单一事实来源：生成/批准/切换版本后重新拉取）。 */
  const [outlines, setOutlines] = useState<Outline[]>([]);
  /** 当前选中章的版本历史（同一章可多版本，轻量历史版本用）。 */
  const [versions, setVersions] = useState<Outline[]>([]);
  /** 详情当前展示的版本 id：默认 = 选中章当前生效版；点历史版本项时切到该版本预览。 */
  const [viewVersionId, setViewVersionId] = useState<string | null>(null);
  // 数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(true);
  /** 生效蓝图的分卷信息：用于大纲按卷分组、章节所处阶段推导（deriveStage）与视角角色过滤。 */
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  /** 生效蓝图标题：null = 无生效蓝图（新增大纲的前提，无蓝图时弹窗内提示并禁用生成）。 */
  const [blueprintTitle, setBlueprintTitle] = useState<string | null>(null);
  /** 视角角色下拉的数据源（设定库 character 类，仅保留手动/批量 + 当前生效蓝图导入的角色）。 */
  const [characters, setCharacters] = useState<Setting[]>([]);
  /** 生成表单：章节号 + 目标 + 章节功能 + 视角（打开弹窗时重置；重写模式章节号锁定）。 */
  const [form, setForm] = useState<GenForm>(EMPTY_FORM);
  /** 生成进行中标志：驱动按钮禁用、生成过程弹窗开关，恢复轮询结束后解除。 */
  const [generating, setGenerating] = useState(false);
  /** 生成的正文流式输出（SSE 累积；恢复时用后端任务累积内容反填，刷新前已流出的不丢）。 */
  const [draftText, setDraftText] = useState("");
  /** 生成的思考过程流式输出（推理模型思考期文本）。 */
  const [thinkingText, setThinkingText] = useState("");
  /** 生成过程弹窗（参考蓝图页：点击「查看生成过程」打开，DeepSeek 风格实时流式展示）。 */
  const [showStreamModal, setShowStreamModal] = useState(false);
  // 生成启动（本页发起或刷新恢复）：自动弹出生成过程弹窗（生成中会出现需要作者确认的选择）
  useEffect(() => {
    if (generating) setShowStreamModal(true);
  }, [generating]);
  /** 当前选中章的大纲 id：点击列表项设置，默认自动选中最新一章（无选中时才生效）。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 被折叠的卷 key（默认全展开）。搜索时强制展开匹配卷（与写作页章节目录一致）。 */
  const [collapsedKeys, setCollapsedKeys] = useState<Record<string, boolean>>({});
  /** 大纲搜索词（按章号/标题过滤）。 */
  const [outlineSearch, setOutlineSearch] = useState("");
  // 新增大纲弹窗（参考蓝图页「新增蓝图」：按钮 + Modal）
  const [showAddModal, setShowAddModal] = useState(false);
  /** 新增弹窗的模式：null = 新增大纲（章节号自动推导）；number = 重写指定章（章节号锁定，标题行「重写」按钮进入）。 */
  const [rewriteChapterNo, setRewriteChapterNo] = useState<number | null>(null);
  /** 版本选择弹窗（点击详情标题右侧的 vN 打开）。 */
  const [showVersionModal, setShowVersionModal] = useState(false);
  /** 本次生成的开始时刻（供生成过程弹窗统计已用时）。 */
  const [startAt, setStartAt] = useState<number | null>(null);
  /** 生成已耗时（仅 generating 期间走表，任务停止后归零）。 */
  const elapsed = useElapsed(generating, startAt);
  /** 批准二次确认：该章已生成正文时，切换大纲版本需确认（正文不会自动重写）。 */
  const [confirmApprove, setConfirmApprove] = useState<Outline | null>(null);
  /** 正在后台批准注入的大纲版本 id（按钮防抖 + 刷新/切页后从后端恢复「批准中…」；成功/失败才置空） */
  const [approvingId, setApprovingId] = useState<string | null>(null);
  // 本次生成成功落库的章节号 + 新版本 id（stored 事件写入，供完成后选中新草稿、顺延默认章节号）
  const storedChapterRef = useRef<number | null>(null);
  const storedIdRef = useRef<string | null>(null);
  /** AI 服务状态检查：生成前确认模型已配置可用，未配置则抛错拦截（避免发起注定失败的空请求）。 */
  const { ensureReady } = useAiStatus();

  /** 拉取该小说的章节大纲 + 生效蓝图 + 视角角色：成功写入状态并返回大纲列表；失败弹错误提示并返回 []。 */
  const load = useCallback(async (): Promise<Outline[]> => {
    setLoading(true);
    try {
      const [outs, bp, chars] = await Promise.all([
        listOutlines(novelId),
        getActiveBlueprint(novelId).catch(() => null), // 无 active 蓝图不阻塞大纲加载
        listSettings(novelId, "character").catch(() => [] as Setting[]), // 视角角色下拉
      ]);
      setOutlines(outs);
      setVolumes(bp?.content?.volumes ?? []);
      setBlueprintTitle(bp?.content?.title ?? null);
      // 视角角色只保留「手动/批量」+ 当前生效蓝图导入的设定；未生效蓝图版本导入的角色不出现（与设定页一致）
      const visibleChars = chars.filter(
        (s) => s.source !== "blueprint" || s.blueprint_id === bp?.id,
      );
      setCharacters(visibleChars);
      // 有数据时默认选中最新一章（章节号最大）；无选中才生效，不覆盖用户当前选择
      setSelectedId((cur) => {
        if (cur) return cur;
        if (outs.length === 0) return null;
        return outs.reduce((a, b) => (a.chapter_no > b.chapter_no ? a : b)).id;
      });
      return outs;
    } catch (e) {
      message.error((e as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 页面刷新 / 切页重挂载后：若后端有该小说进行中的 outliner 任务（agent_tasks），恢复「生成中」状态并轮询到完成。
   *  避免刷新后章节号重新推导、用户误以为可以再次生成同一章（与蓝图页 tryResumeBlueprintRun 同机制）。 */
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let r: AgentRunningTaskResult;
      try {
        r = await getAgentRunningTask("outliner", novelId);
      } catch {
        return;
      }
      if (stopped || !r.running || !r.task) return;
      const task = r.task;
      // 恢复生成中状态：用后端累积的流式文字与任务真实开始时间（刷新前已流出的内容不丢）
      setStartAt(task.started_at ? new Date(task.started_at).getTime() : Date.now());
      setGenerating(true);
      setThinkingText(task.progress?.thinking ?? "");
      setDraftText(task.progress?.draft ?? "");
      // 轮询到任务结束
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let r2: AgentRunningTaskResult;
        try {
          r2 = await getAgentRunningTask("outliner", novelId);
        } catch {
          break; // 查询失败：停止轮询，不再强行维持「生成中」
        }
        if (r2.running && r2.task) {
          const p = r2.task.progress;
          if (p) {
            setThinkingText(p.thinking);
            setDraftText(p.draft);
          }
          continue;
        }
        // 任务已结束：/tasks 只返回 running 任务（结束后 task 为 null），
        // 需借 /status 的 recent 判断本角色任务是否失败，避免失败被误报为成功
        let outlineError: string | null = null;
        try {
          const st = await getStreamStatus(novelId);
          if (st.recent && st.recent.agent === "outliner" && st.recent.status === "error") {
            outlineError = st.recent.error;
          }
        } catch {
          /* 查询失败按完成处理 */
        }
        if (outlineError) {
          message.error(`大纲生成失败：${friendlyTaskError(outlineError, "后台任务失败")}`);
        } else {
          message.success("大纲已生成完毕");
          // 与蓝图页一致：生成完成自动关闭「生成过程」与「新增大纲」弹窗
          setShowStreamModal(false);
          setShowAddModal(false);
          await load();
        }
        break;
      }
      if (!stopped) setGenerating(false);
    })();
    return () => {
      stopped = true;
    };
  }, [novelId, load]);

  // 批准轮询：后台批准注入（角色设定 + 账本同步）期间每 1.5s 查询一次批准状态，「批准中…」保持到成功或失败才退出。
  // 刷新/切页后由 mount 恢复逻辑重新接管；组件卸载/切换小说时停止轮询（任务仍在后台跑）。
  const stopApprovalPoll = useRef<() => void>(() => {});
  /** 当前面板所属小说：切换小说时用它让旧小说的轮询立即退场，不误弹提示 */
  const lastApprovalNovelRef = useRef<string | null>(null);
  const pollApproval = useCallback(
    (novelId: string) => {
      stopApprovalPoll.current(); // 停止上一轮（同一小说只保留一个轮询）
      let stopped = false;
      stopApprovalPoll.current = () => {
        stopped = true;
      };
      void (async () => {
        while (!stopped) {
          await new Promise((r) => setTimeout(r, 1500));
          if (stopped) return;
          // 期间切换到其他小说：立即退场，不弹本小说的完成提示（状态由新小说自己的恢复逻辑接管）
          if (lastApprovalNovelRef.current !== novelId) {
            stopApprovalPoll.current = () => {};
            return;
          }
          let r: OutlineApprovalStatusResult;
          try {
            r = await getOutlineApprovalStatus(novelId);
          } catch {
            continue; // 查询失败静默，下轮再试
          }
          if (r.running) continue; // 仍在后台批准注入：按钮保持「批准中…」
          stopApprovalPoll.current = () => {}; // 收尾后清掉停止句柄
          const t = r.task;
          // 本面板已卸载（切页签）：不再弹居中 Message，跨页完成由全局右上角通知兜底
          const onPanel = liveNovelRef.current === novelId && mountedRef.current;
          if (t && t.status === "error") {
            setApprovingId(null);
            if (onPanel) message.error(`大纲批准失败：${friendlyTaskError(t.error, "请稍后重试")}`);
          } else if (t && t.outline_id) {
            setApprovingId(null);
            const n = t.injected_characters?.length ?? 0;
            if (onPanel) {
              message.success(
                `第 ${t.chapter_no} 章大纲（第${t.version_no}版）已确认，AI 写正文时会优先参考。` +
                  (n ? `并自动把 ${n} 个新角色加进了设定集。` : ""),
              );
            }
          } else {
            // 无任务记录（异常情况）：直接退出批准中
            setApprovingId(null);
          }
          await load();
          const oid = t?.outline_id;
          if (oid) {
            // 刷新版本历史，并把详情/列表选中都切到刚批准（当前生效）的版本
            const vs = await listOutlineVersions(novelId, oid).catch(() => [] as Outline[]);
            setVersions(vs);
            setViewVersionId(oid);
            setSelectedId(oid);
          }
          return;
        }
      })();
    },
    [load],
  );

  // 切换小说：停止上一部小说的批准轮询、清空「批准中…」状态——各小说的批准状态互相隔离，
  // 上一部小说的批准任务完成/失败不会在当前小说工作台误弹提示。
  useEffect(() => {
    if (lastApprovalNovelRef.current !== novelId) {
      lastApprovalNovelRef.current = novelId;
      stopApprovalPoll.current();
      stopApprovalPoll.current = () => {};
      setApprovingId(null);
    }
  }, [novelId]);

  // 页面刷新 / 切页回来：若后端有该小说进行中的批准任务，恢复对应大纲的「批准中…」并轮询到完成
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let r: OutlineApprovalStatusResult;
      try {
        r = await getOutlineApprovalStatus(novelId);
      } catch {
        return;
      }
      if (stopped) return;
      if (!r.running || !r.task?.outline_id) return;
      setApprovingId(r.task.outline_id);
      setSelectedId(r.task.outline_id);
      pollApproval(novelId);
    })();
    return () => {
      stopped = true;
    };
  }, [novelId, pollApproval]);

  // 组件卸载时停止批准轮询（任务在后台继续，回来后由上方 mount 效果重新接管）
  useEffect(() => {
    return () => {
      stopApprovalPoll.current();
      stopApprovalPoll.current = () => {};
    };
  }, []);

  // 选中章变化时：拉取该章全部版本（历史切换用），详情默认展示当前生效版
  useEffect(() => {
    if (!selectedId) {
      setVersions([]);
      setViewVersionId(null);
      return;
    }
    let cancelled = false;
    listOutlineVersions(novelId, selectedId)
      .then((vs) => {
        if (cancelled) return;
        setVersions(vs);
        setViewVersionId((cur) => cur && vs.some((v) => v.id === cur) ? cur : null);
      })
      .catch(() => { /* 版本历史加载失败不阻塞详情 */ });
    return () => {
      cancelled = true;
    };
  }, [novelId, selectedId]);

  const selected = outlines.find((o) => o.id === selectedId) ?? null;
  const groups = groupByVolume(outlines, volumes);
  // 搜索：按「第N章 标题」过滤，空搜索时保持按卷归组（与写作页章节目录一致）
  const outlineQ = outlineSearch.trim().toLowerCase();
  const outlineMatches = (o: Outline) =>
    !outlineQ || `第${o.chapter_no}章 ${o.title ?? ""}`.toLowerCase().includes(outlineQ);
  // 搜索过滤后的卷分组（只保留命中组；空搜索即全量）——传给 OutlineList 直接渲染
  const filteredGroups = groups
    .map((g) => {
      const items = outlineQ ? g.items.filter(outlineMatches) : g.items;
      return items.length > 0 ? { g, items } : null;
    })
    .filter((x): x is { g: VolumeGroup; items: Outline[] } => x != null);

  // 视角角色：仅列出当前章节号下生效的角色（生效阶段/出场章节范围/隐藏 与后端过滤一致）
  const stage = deriveStage(form.chapter_no, volumes);
  const activeCharacters = characters.filter((c) => isCharacterActive(c, form.chapter_no, volumes));
  const inactiveCharacters = characters.filter(
    (c) => !isCharacterActive(c, form.chapter_no, volumes),
  );

  /** 打开「新增大纲」弹窗：每次打开按当前大纲重算自动章节号，并清空上次表单。
   *  rewriteNo 不为 null 时是「重写指定章」模式：章节号锁定为 rewriteNo，不参与自动推导。
   *  生成中的入口互斥：新增生成中禁重写、重写生成中禁新增（按钮 disabled 之外的双保险）。 */
  function openAddModal(rewriteNo: number | null = null) {
    if (rewriteNo == null ? generatingRewrite : generatingNew) return;
    setRewriteChapterNo(rewriteNo);
    setForm({
      ...EMPTY_FORM,
      chapter_no: rewriteNo ?? nextAutoChapterNo(outlines, volumes),
    });
    setShowAddModal(true);
  }

  /** 生成中的模式互斥标记：新增生成中禁「重写」，重写生成中禁「新增大纲」；生成完毕（generating=false）都恢复。 */
  const generatingNew = generating && rewriteChapterNo == null;
  const generatingRewrite = generating && rewriteChapterNo != null;

  /** 详情当前展示的版本：有正在预览的历史版本就用它，否则是选中章当前生效版。 */
  const viewing = versions.find((v) => v.id === viewVersionId) ?? selected;
  const content = viewing?.content as OutlineContent | undefined;

  /** 发起大纲生成：置生成中 → 校验 AI 配置 → runAgent SSE 流式调用（回调里分流处理流式/确认/stored 事件）。
   *  成功判定：SSE 事件流中出现 stored（带 chapter_no + id）即视为成功落库，统一在 finally 出口提示一次
   *  （stored 事件与刷新恢复路径都不再重复弹，避免双提示）；失败判定：try 抛错（friendlyRunError）或
   *  stream_error 事件，均弹错误提示。跨小说/卸载守卫：回调与收尾都用 liveNovelRef/mountedRef 判断，
   *  切走后不写入状态、不刷新、不提示。 */
  async function handleGenerate() {
    setGenerating(true);
    setStartAt(Date.now());
    setDraftText("");
    setThinkingText("");
    storedChapterRef.current = null;
    storedIdRef.current = null;
    const params: Record<string, unknown> = {
      chapter_no: form.chapter_no,
      rewrite: rewriteChapterNo != null,
      goal: form.goal.trim() || undefined,
      chapter_function: form.chapter_function,
      pov: form.pov.trim() || undefined,
    };
    try {
      ensureReady();
      await runAgent("outliner", novelId, params, (ev) => {
        // 切到其他小说、或本面板已卸载（切页签）：后续回调不再弹全局提示、不再写入状态
        if (liveNovelRef.current !== novelId || !mountedRef.current) return;
        const d = ev.data as { delta?: string; status?: string; chapter_no?: number; id?: string };
        if (ev.event === "thinking_delta" && d.delta) {
          setThinkingText((prev) => prev + d.delta);
        } else if (ev.event === "stream_delta" && d.delta) {
          setDraftText((prev) => prev + d.delta);
        } else if (ev.event === "schema_validate") {
          if (d.status !== "ok") message.error("大纲格式校验失败，可重试。");
        } else if (ev.event === "stored") {
          // 只记录落库结果，不在此弹提示——成功提示统一在 finally 出口弹一次，避免与恢复路径重复
          if (typeof d.chapter_no === "number") storedChapterRef.current = d.chapter_no;
          if (typeof d.id === "string") storedIdRef.current = d.id;
        } else if (ev.event === "stream_error") {
          message.error((ev.data as { message?: string }).message ?? "AI 生成大纲出错，请稍后重试。");
        } else if (ev.event === "author_confirm") {
          // 大纲方向提案确认点：全局弹窗交给作者定夺（3 选项 + 自定义）
          const c = (ev.data as { confirm?: AuthorConfirm }).confirm;
          if (c?.id && c.novel_id === novelId) pushAuthorConfirm(c);
        }
      });
    } catch (e) {
      if (liveNovelRef.current === novelId && mountedRef.current) message.error(friendlyRunError(e));
    } finally {
      setGenerating(false);
      setDraftText("");
      setThinkingText("");
      if (liveNovelRef.current !== novelId || !mountedRef.current) return; // 已切小说/已切页签：不再用本小说的结果刷新/选中
      const outs = await load();
      const storedNo = storedChapterRef.current;
      const storedId = storedIdRef.current;
      storedChapterRef.current = null;
      storedIdRef.current = null;
      if (storedNo != null) {
        // 生成成功：统一出口只提示一次（stored 事件与恢复路径均不再重复弹）
        message.success(`第 ${storedNo} 章大纲已生成完毕（未批准），可在详情里批准此版本。`);
        // 关闭弹窗、精确选中刚生成的草稿版本
        setShowAddModal(false);
        setShowStreamModal(false);
        const created = storedId ? outs.find((o) => o.id === storedId) ?? null : null;
        setSelectedId(created?.id ?? outs.find((o) => o.chapter_no === storedNo)?.id ?? null);
        // 刷新该章版本历史（新版本并入），详情定位到新草稿
        if (storedId) {
          const vs = await listOutlineVersions(novelId, storedId).catch(() => [] as Outline[]);
          setVersions(vs);
          setViewVersionId(storedId);
        }
        // 重写模式：保持该章（表单下次打开再算）；新增模式：默认章节号顺延到下一条
        if (rewriteChapterNo == null) setForm({ ...EMPTY_FORM, chapter_no: storedNo + 1 });
        setRewriteChapterNo(null);
      }
    }
  }

  /** 真正执行批准（handleApprove 二次确认通过后调用）。 */
  async function doApprove(o: Outline) {
    if (approvingId) return;
    // 先置「批准中…」：按钮立即反馈，且防止重复点击（后端同样有并发兜底 409）
    setApprovingId(o.id);
    setSelectedId(o.id);
    let res;
    try {
      res = await approveOutline(novelId, o.id);
    } catch (e) {
      // 请求失败（如已有任务在批准 409 / 网络错误）：立即退出批准中
      setApprovingId(null);
      message.error((e as Error).message);
      return;
    }
    if (!res.running) {
      // 已批准（并发下其他请求已完成）：无需轮询，直接刷新展示
      setApprovingId(null);
      message.success(`第 ${o.chapter_no} 章大纲（第${o.version_no}版）已确认，AI 写正文时会优先参考。`);
      await load();
      // 刷新版本历史，并把详情/列表选中都切到刚批准（当前生效）的版本
      const vs = await listOutlineVersions(novelId, o.id).catch(() => [] as Outline[]);
      setVersions(vs);
      setViewVersionId(o.id);
      setSelectedId(o.id);
      return;
    }
    // 后台批准注入进行中（角色设定 + 账本同步）：轮询到成功/失败才退出「批准中…」（刷新/切页不中断）
    pollApproval(novelId);
  }

  /** 批准（或切换）大纲版本：若该章已生成过正文，先二次确认（正文不会自动重写）。 */
  async function handleApprove(o: Outline) {
    try {
      const { has_chapter } = await outlineHasChapter(novelId, o.id);
      if (has_chapter) {
        // 该章已有正文：批准新版本等于替换该章大纲，正文与之脱钩，需用户确认自行决定
        setConfirmApprove(o);
        return;
      }
      await doApprove(o);
    } catch {
      // 查询失败不阻塞批准（判定接口异常时按无正文处理，直接批准）
      await doApprove(o);
    }
  }

  /** 点击卷标题：收缩 / 展开该卷下的章节列表 */
  function toggleCollapse(key: string) {
    setCollapsedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <Loading loading={loading}>
      <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      {/* 左侧：章节大纲（与写作页「章节目录」模块统一：按卷分组、可展开、可搜索）。
          模块高度跟随内容，最多与页面底部对齐；内容多时在列表内滚动，互不影响其他模块。 */}
      <OutlineList
        total={outlines.length}
        groups={filteredGroups}
        outlineSearch={outlineSearch}
        outlineQ={outlineQ}
        collapsedKeys={collapsedKeys}
        selectedId={selectedId}
        generatingRewrite={generatingRewrite}
        onSearchChange={setOutlineSearch}
        onToggleCollapse={toggleCollapse}
        onSelect={setSelectedId}
        onAdd={() => openAddModal()}
      />

      {/* 右侧：大纲详情 */}
      <section className="flex min-w-0 flex-col gap-5 sm:gap-7">
        {!selected && (
          <div className="panel flex min-h-0 flex-col gap-3">
            <div className="panel-head mb-0">
              <h3 className="panel-title">大纲详情</h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有大纲。点左侧「新增大纲」，让 AI 排出第一章大纲。
            </p>
          </div>
        )}

        {/* 大纲详情 */}
        {selected && viewing && (
          <OutlineDetail
            viewing={viewing}
            versions={versions}
            showVersionModal={showVersionModal}
            content={content}
            generatingNew={generatingNew}
            approvingId={approvingId}
            onToggleVersionModal={() => setShowVersionModal((o) => !o)}
            onCloseVersionModal={() => setShowVersionModal(false)}
            onSelectVersion={(id) => {
              setViewVersionId(id);
              setShowVersionModal(false);
            }}
            onRewrite={(no) => openAddModal(no)}
            onApprove={(o) => void handleApprove(o)}
          />
        )}
      </section>

      {/* ── 新增大纲弹窗（参考蓝图页「新增蓝图」/写作页「新增章节」：按钮 + Modal）。
           rewriteChapterNo != null 时是「重写本章」：章节号锁定，生成的是本章的新版本（与旧版本各自独立）。 ── */}
      <GenOutlineModal
        open={showAddModal}
        rewriteChapterNo={rewriteChapterNo}
        form={form}
        stage={stage}
        activeCharacters={activeCharacters}
        inactiveCharacters={inactiveCharacters}
        blueprintTitle={blueprintTitle}
        generating={generating}
        volumes={volumes}
        onClose={() => setShowAddModal(false)}
        onFormChange={setForm}
        onGenerate={handleGenerate}
        onShowStream={() => setShowStreamModal(true)}
      />

      {/* ── 版本选择已改为详情标题 vN 旁的内联浮层（见上方 trigger），不再用弹窗 ── */}

      {/* ── 生成过程弹窗：DeepSeek 网页版同款交互（复用公共组件，参考蓝图页） ── */}
      <AgentStreamModal
        open={showStreamModal}
        onClose={() => setShowStreamModal(false)}
        title="AI 生成过程"
        running={generating}
        draftText={draftText}
        thinkingText={thinkingText}
        elapsed={elapsed}
        novelId={novelId}
        emptyRunningText={
          "AI 正在思考整理大纲，头几分钟通常没字，属正常，\n正文开始生成后会在这里实时滚动显示…"
        }
        emptyDoneText="新大纲已存好，还是草稿状态，在详情里点「批准」后才会启用。"
      />

      {/* ── 批准二次确认：该章已生成正文，切换大纲版本后正文不会自动重写 ── */}
      <ConfirmDialog
        open={confirmApprove != null}
        title="该章已生成正文，确认切换大纲？"
        message={
          confirmApprove
            ? `第 ${confirmApprove.chapter_no} 章已经生成过正文。\n\n批准 v${confirmApprove.version_no} 后，该章大纲将切换为新版本，但已生成的正文不会自动重写，二者可能不一致。是否继续？\n\n如需保持一致，请切到「写作」页重新生成该章正文。`
            : ""
        }
        confirmText="确认切换"
        cancelText="取消"
        tone="danger"
        onConfirm={() => {
          if (confirmApprove) {
            const o = confirmApprove;
            setConfirmApprove(null);
            void doApprove(o);
          }
        }}
        onCancel={() => setConfirmApprove(null)}
      />
      </div>
    </Loading>
  );
}
