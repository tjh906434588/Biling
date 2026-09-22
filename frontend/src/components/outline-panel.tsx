"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveOutline,
  friendlyRunError,
  getActiveBlueprint,
  getAgentRunningTask,
  getOutlineApprovalStatus,
  listOutlines,
  listOutlineVersions,
  listSettings,
  outlineHasChapter,
  runAgent,
  type AgentRunningTaskResult,
  type Blueprint,
  type Outline,
  type OutlineApprovalStatusResult,
  type Setting,
} from "@/lib/api";
import Modal from "./modal";
import ConfirmDialog from "./confirm-dialog";
import AgentStreamModal from "./agent-stream-modal";
import { useElapsed } from "@/lib/use-elapsed";
import { message } from "@/components/message";
import Loading from "@/components/loading";
import { CostHint, useAiStatus } from "@/lib/ai-status";

interface Props {
  novelId: string;
}

interface GenForm {
  chapter_no: number;
  goal: string;
  chapter_function: string;
  pov: string;
}

const FUNCTIONS = [
  ["progression", "推进"],
  ["buildup", "铺垫"],
  ["turning", "转折"],
  ["climax", "高潮"],
  ["revelation", "揭秘"],
  ["resolution", "收束"],
  ["interlude", "间奏"],
] as const;

const EMPTY_FORM: GenForm = {
  chapter_no: 1,
  goal: "",
  chapter_function: "", // 留空 = 由大纲师按剧情节奏自动判定
  pov: "",
};

const FUNCTION_LABELS: Record<string, string> = Object.fromEntries(FUNCTIONS);

/** 视角角色按戏份分组（与设定库 role_rank 一致），方便区分主角 / 配角。 */
const ROLE_RANKS = [
  { value: "protagonist", label: "主角" },
  { value: "major", label: "重要配角" },
  { value: "minor", label: "次要配角" },
  { value: "extra", label: "龙套 / 炮灰" },
] as const;

function roleRankOf(s: Setting): string {
  const rk = s.structured?.role_rank;
  return typeof rk === "string" ? rk : "";
}

const STAGE_LABEL: Record<string, string> = { early: "前期", middle: "中期", late: "后期" };

/** 与后端 derive_stage 一致：按蓝图 volumes 最大结束章三分全书，推导章节所处阶段。 */
function deriveStage(chapterNo: number, volumes: VolumeInfo[] | undefined): string | null {
  if (!volumes || chapterNo <= 0) return null;
  let total = 0;
  for (const v of volumes) {
    const rng = v.chapters_range ?? "";
    const idx = rng.lastIndexOf("-");
    if (idx >= 0) {
      const end = Number(rng.slice(idx + 1).trim());
      if (Number.isFinite(end)) total = Math.max(total, end);
    }
  }
  if (total <= 0) return null;
  const third = total / 3;
  if (chapterNo <= third) return "early";
  if (chapterNo <= third * 2) return "middle";
  return "late";
}

/** 与后端 filter_settings_for_chapter 一致：角色在指定章节是否生效（生效阶段/章节范围）。 */
function isCharacterActive(
  c: Setting,
  chapterNo: number,
  volumes: VolumeInfo[] | undefined,
): boolean {
  const st = c.structured ?? {};
  if (typeof st.appear_from === "number" && chapterNo < st.appear_from) return false;
  if (typeof st.appear_until === "number" && chapterNo > st.appear_until) return false;
  const stage = deriveStage(chapterNo, volumes);
  if (stage && Array.isArray(st.stages) && st.stages.length > 0 && !st.stages.includes(stage)) {
    return false;
  }
  return true;
}

/** 该角色在指定章节不生效的原因（用于置灰展示，让被过滤的角色不会凭空消失）。 */
function inactiveReason(
  c: Setting,
  chapterNo: number,
  volumes: VolumeInfo[] | undefined,
): string {
  const st = c.structured ?? {};
  if (typeof st.appear_from === "number" && chapterNo < st.appear_from) {
    return `出场于第 ${st.appear_from} 章起`;
  }
  if (typeof st.appear_until === "number" && chapterNo > st.appear_until) {
    return `第 ${st.appear_until} 章后退场`;
  }
  const stage = deriveStage(chapterNo, volumes);
  if (stage && Array.isArray(st.stages) && st.stages.length > 0 && !st.stages.includes(stage)) {
    return `于${(st.stages as string[]).map((x) => STAGE_LABEL[x] ?? x).join("、")}阶段出场`;
  }
  return "本章未生效";
}

const TYPE_LABELS: Record<string, string> = {
  scene: "场景",
  transition: "过场",
  dialogue: "对话",
  action: "动作",
  reveal: "揭示",
};

type VolumeInfo = NonNullable<Blueprint["content"]["volumes"]>[number];

interface VolumeGroup {
  key: string;
  label: string;
  subtitle: string;
  items: Outline[];
}

/** 蓝图没有分卷（或卷的章节范围全无法解析）时的兜底卷：所有章节归入「第1卷」，避免散成「未分卷」。 */
const DEFAULT_VOLUME: VolumeInfo = { no: 1, name: "", focus: "", chapters_range: "" };

/** 把章节大纲按当前生效蓝图的 volumes（chapters_range）归组；蓝图无卷时兜底为默认「第1卷」。 */
function groupByVolume(outlines: Outline[], volumes: VolumeInfo[] | undefined): VolumeGroup[] {
  const vols = volumes ?? [];
  const parsed = vols
    .map((v) => {
      const m = v.chapters_range?.match(/(\d+)\s*[-~至到]\s*(\d+)/);
      return { v, start: m ? Number(m[1]) : NaN, end: m ? Number(m[2]) : NaN };
    })
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end));

  // 无卷或全部卷范围解析失败 → 用一个默认「第1卷」吸收全部章节
  const effectiveVols = parsed.length > 0 ? vols : [DEFAULT_VOLUME];
  const effectiveParsed =
    parsed.length > 0 ? parsed : [{ v: DEFAULT_VOLUME, start: 1, end: Number.MAX_SAFE_INTEGER }];

  const groups: VolumeGroup[] = effectiveVols.map((v) => ({
    key: `vol-${v.no ?? v.name ?? "?"}`,
    label: `${v.no != null ? `第${v.no}卷` : "卷"}${v.name ? ` · ${v.name}` : ""}`,
    subtitle: [v.chapters_range && `${v.chapters_range}章`, v.chapter_count, v.word_count]
      .filter(Boolean)
      .join(" · "),
    items: [],
  }));
  const rest: VolumeGroup = { key: "rest", label: "未分卷", subtitle: "", items: [] };

  for (const o of [...outlines].sort((a, b) => a.chapter_no - b.chapter_no)) {
    const hit = effectiveParsed.find(({ start, end }) => o.chapter_no >= start && o.chapter_no <= end);
    const target = hit
      ? groups.find((g) => g.key === `vol-${hit.v.no ?? hit.v.name ?? "?"}`)
      : undefined;
    (target ?? rest).items.push(o);
  }

  const result = groups.filter((g) => g.items.length > 0);
  if (rest.items.length > 0) result.push(rest);
  return result;
}

export default function OutlinePanel({ novelId }: Props) {
  // 组件实例被 App Router 跨小说复用：记录「当前正在显示的小说」，AI 流回调/收尾据此判断是否已切小说
  const liveNovelRef = useRef(novelId);
  if (liveNovelRef.current !== novelId) liveNovelRef.current = novelId;
  /** 挂载标记：切页签会卸载本面板，但 runAgent 的流回调仍在后台继续。
   *  卸载后不再弹全局 Message（居中的成功/告警提示），避免「切到其他页面完成」时
   *  和全局右上角 Notification 重复弹两条；跨页的完成提醒由 agent-task-toasts 兜底。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [outlines, setOutlines] = useState<Outline[]>([]);
  /** 当前选中章的版本历史（同一章可多版本，轻量历史版本用）。 */
  const [versions, setVersions] = useState<Outline[]>([]);
  /** 详情当前展示的版本 id：默认 = 选中章当前生效版；点历史版本项时切到该版本预览。 */
  const [viewVersionId, setViewVersionId] = useState<string | null>(null);
  // 数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(true);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  /** 生效蓝图标题：null = 无生效蓝图（新增大纲的前提，无蓝图时弹窗内提示并禁用生成）。 */
  const [blueprintTitle, setBlueprintTitle] = useState<string | null>(null);
  const [characters, setCharacters] = useState<Setting[]>([]);
  const [form, setForm] = useState<GenForm>(EMPTY_FORM);
  const [generating, setGenerating] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
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
  /** 生成过程弹窗（参考蓝图页：点击「查看生成过程」打开，DeepSeek 风格实时流式展示）。 */
  const [showStreamModal, setShowStreamModal] = useState(false);
  /** 本次生成的开始时刻（供生成过程弹窗统计已用时）。 */
  const startAtRef = useRef<number | null>(null);
  const elapsed = useElapsed(generating, startAtRef.current);
  /** 批准二次确认：该章已生成正文时，切换大纲版本需确认（正文不会自动重写）。 */
  const [confirmApprove, setConfirmApprove] = useState<Outline | null>(null);
  /** 正在后台批准注入的大纲版本 id（按钮防抖 + 刷新/切页后从后端恢复「批准中…」；成功/失败才置空） */
  const [approvingId, setApprovingId] = useState<string | null>(null);
  // 本次生成成功落库的章节号 + 新版本 id（stored 事件写入，供完成后选中新草稿、顺延默认章节号）
  const storedChapterRef = useRef<number | null>(null);
  const storedIdRef = useRef<string | null>(null);
  const { ensureReady } = useAiStatus();

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
      startAtRef.current = task.started_at ? new Date(task.started_at).getTime() : Date.now();
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
        if (r2.task?.status === "error") {
          message.error(`大纲生成失败：${r2.task.error ?? "后台任务失败"}`);
        } else {
          message.success(r2.task?.msg ?? "大纲已生成完毕");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            if (onPanel) message.error(`大纲批准失败：${t.error ?? "请稍后重试"}`);
          } else if (t && t.outline_id) {
            setApprovingId(null);
            const n = t.injected_characters?.length ?? 0;
            if (onPanel) {
              message.success(
                `第 ${t.chapter_no} 章大纲 v${t.version_no} 已批准此版本（小说家生成时将优先引用）。` +
                  (n ? `并登记了 ${n} 个新角色到设定库。` : ""),
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

  // 视角角色：仅列出当前章节号下生效的角色（生效阶段/出场章节范围/隐藏 与后端过滤一致）
  const stage = deriveStage(form.chapter_no, volumes);
  const activeCharacters = characters.filter((c) => isCharacterActive(c, form.chapter_no, volumes));
  const inactiveCharacters = characters.filter(
    (c) => !isCharacterActive(c, form.chapter_no, volumes),
  );

  /** 自动推导下一个大纲章节号：已有大纲（含草稿）的最大章号 + 1；还没有任何大纲则从第一卷第一章开始 */
  function nextAutoChapterNo(list: Outline[], vols: VolumeInfo[]): number {
    if (list.length === 0) {
      // 第一卷的起始章号（chapters_range 的左边界），无法解析则回退到 1
      const m = vols[0]?.chapters_range?.match(/(\d+)\s*[-~至到]\s*(\d+)/);
      return m ? Number(m[1]) : 1;
    }
    return Math.max(...list.map((o) => o.chapter_no)) + 1;
  }

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
  const content = viewing?.content as
    | {
        no?: number;
        title?: string;
        goal?: string;
        chapter_function?: string;
        pov?: string;
        beats?: Array<{ beat_no?: number; type?: string; pov?: string; content?: string; length_hint?: string; emotion?: string }>;
        conflicts?: Array<{ type?: string; with?: string; stakes?: string }>;
        plant_foreshadowing?: Array<{ desc?: string; payoff_hint?: string; latest_payoff_chapter?: number }>;
        resolve_foreshadowing?: Array<{ ledger_id?: string; how?: string }>;
        thread_updates?: Array<{ thread?: string; new_state?: string }>;
      }
    | undefined;

  async function handleGenerate() {
    setGenerating(true);
    startAtRef.current = Date.now();
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
          if (d.status !== "ok") message.error("大纲 schema 校验失败，可重试。");
        } else if (ev.event === "stored") {
          // 只记录落库结果，不在此弹提示——成功提示统一在 finally 出口弹一次，避免与恢复路径重复
          if (typeof d.chapter_no === "number") storedChapterRef.current = d.chapter_no;
          if (typeof d.id === "string") storedIdRef.current = d.id;
        } else if (ev.event === "stream_error") {
          message.error((ev.data as { message?: string }).message ?? "AI 生成大纲出错，请稍后重试。");
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
      message.success(`第 ${o.chapter_no} 章大纲 v${o.version_no} 已批准此版本。`);
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
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)] xl:gap-8">
      {/* 左侧：章节大纲（与写作页「章节目录」模块统一：按卷分组、可展开、可搜索）。
          模块高度跟随内容，最多与页面底部对齐；内容多时在列表内滚动，互不影响其他模块。 */}
      <aside className="flex max-h-[calc(100dvh-6rem)] min-w-0 flex-col gap-4 overflow-hidden">
        <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="panel-head shrink-0">
            <h3 className="panel-title">章节大纲</h3>
            <div className="flex items-center gap-2">
              <span className="panel-hint">{outlines.length} 条</span>
              <button
                type="button"
                onClick={() => openAddModal()}
                disabled={generatingRewrite}
                title={generatingRewrite ? "大纲生成中，暂不能新增大纲" : undefined}
                className="btn btn-primary px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                新增大纲
              </button>
            </div>
          </div>
          {outlines.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有大纲。点右上角「新增大纲」，让大纲师产出第 N 章大纲。
            </p>
          ) : (
            <>
              <input
                className="mb-3 w-full shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                placeholder="搜索大纲（章号 / 标题）"
                value={outlineSearch}
                onChange={(e) => setOutlineSearch(e.target.value)}
              />
              <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                {groups
                  .map((g) => {
                    const items = outlineQ ? g.items.filter(outlineMatches) : g.items;
                    return items.length > 0 ? { g, items } : null;
                  })
                  .filter((x): x is { g: VolumeGroup; items: Outline[] } => x != null)
                  .map(({ g, items }, idx, arr) => {
                    const collapsed = !outlineQ && collapsedKeys[g.key];
                    const isLast = idx === arr.length - 1;
                    return (
                      <section key={g.key} className={isLast ? "" : "mb-2"}>
                        <button
                          type="button"
                          onClick={() => !outlineQ && toggleCollapse(g.key)}
                          title={collapsed ? "展开该卷章节" : "收起该卷章节"}
                          className={`mb-1.5 flex w-full items-start gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors ${
                            outlineQ
                              ? "cursor-default"
                              : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                          }`}
                        >
                          <span
                            className={`mt-0.5 shrink-0 text-[10px] text-zinc-400 transition-transform ${
                              collapsed ? "-rotate-90" : ""
                            }`}
                          >
                            ▾
                          </span>
                          <div className="min-w-0 flex-1">
                            <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400">{g.label}</h4>
                            {g.subtitle && (
                              <span className="mt-0.5 block text-[10px] text-zinc-400">{g.subtitle}</span>
                            )}
                          </div>
                          <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{items.length} 章</span>
                        </button>
                        {!collapsed && (
                          <ul className="flex flex-col gap-2">
                            {items.map((o) => (
                              <li key={o.id}>
                                <button
                                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                                    selectedId === o.id
                                      ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
                                      : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                                  }`}
                                  onClick={() => setSelectedId(o.id)}
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium">
                                      第{o.chapter_no}章{o.title ? ` ${o.title}` : ""}
                                    </span>
                                    {o.status === "approved" ? (
                                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
                                        已批准
                                      </span>
                                    ) : (
                                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                                        未批准
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 line-clamp-1 text-[11px] text-zinc-500">
                                    {(o.content?.goal as string | undefined) ?? ""}
                                  </div>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* 右侧：大纲详情 */}
      <section className="flex min-w-0 flex-col gap-5 sm:gap-7">
        {!selected && (
          <div className="panel flex min-h-0 flex-col gap-3">
            <div className="panel-head mb-0">
              <h3 className="panel-title">大纲详情</h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有大纲。点左侧「新增大纲」，让大纲师排出第一章大纲。
            </p>
          </div>
        )}

        {/* 大纲详情 */}
        {selected && viewing && (
          <div className="panel flex max-h-[calc(100dvh-6rem)] min-h-0 flex-col overflow-hidden">
            <div className="panel-head shrink-0">
              <h3 className="panel-title">
                第 {viewing.chapter_no} 章大纲
                {viewing.title ? ` ${viewing.title}` : ""}
                {content?.pov ? <span className="ml-2 text-xs font-normal text-zinc-500">视角：{content.pov}</span> : null}
                {content?.chapter_function ? (
                  <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    节奏：{FUNCTION_LABELS[content.chapter_function] ?? content.chapter_function}
                  </span>
                ) : null}
              </h3>
              <div className="flex shrink-0 items-center gap-2">
                {/* 版本号按钮：点击打开版本选择弹窗；旁标当前展示版本是否已批准 */}
                <button
                  type="button"
                  onClick={() => setShowVersionModal(true)}
                  className="flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  title="点击切换大纲版本"
                >
                  <span>v{viewing.version_no}</span>
                </button>
                {/* 重写当前章大纲：复用新增大纲弹窗，章节号锁定为本章（生成的新版本与旧版本各自独立） */}
                <button
                  type="button"
                  onClick={() => openAddModal(viewing.chapter_no)}
                  disabled={generatingNew}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  title={
                    generatingNew
                      ? "大纲生成中，暂不能重写"
                      : "重写本章大纲：生成一个新版本（未批准），批准后切换生效"
                  }
                >
                  重写
                </button>
                {viewing.status === "draft" ? (
                  <button
                    className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => handleApprove(viewing)}
                    disabled={approvingId !== null}
                  >
                    {approvingId !== null ? "批准中…" : "批准此版本"}
                  </button>
                ) : (
                  <span className="rounded bg-green-100 px-2 py-1 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
                    当前生效
                  </span>
                )}
              </div>
            </div>

            {/* 详情正文：超出页面高度时在该区域内滚动，头部「批准此版本」保持可见 */}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {content?.goal && (
              <p className="mb-3 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
                <span className="font-semibold">目标：</span>
                {content.goal}
              </p>
            )}

            {content?.beats && content.beats.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">节拍（beats）</h4>
                <ol className="flex flex-col gap-1.5">
                  {content.beats.map((b, i) => (
                    <li key={i} className="rounded-lg border border-zinc-200 p-2.5 text-sm dark:border-zinc-800">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                          #{b.beat_no ?? i + 1} · {TYPE_LABELS[b.type ?? ""] ?? b.type ?? "场景"}
                        </span>
                        {b.pov && <span>视角 {b.pov}</span>}
                        {b.length_hint && <span>{b.length_hint}</span>}
                        {b.emotion && <span>情绪：{b.emotion}</span>}
                      </div>
                      <div className="text-zinc-700 dark:text-zinc-300">{b.content}</div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {content?.conflicts && content.conflicts.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">冲突</h4>
                <ul className="flex flex-col gap-1">
                  {content.conflicts.map((c, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] dark:bg-zinc-800">
                        {c.type === "internal" ? "内心" : "外部"}
                      </span>{" "}
                      与{c.with} · 赌注：{c.stakes}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {content?.plant_foreshadowing && content.plant_foreshadowing.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">埋设伏笔（入账）</h4>
                <ul className="flex flex-col gap-1">
                  {content.plant_foreshadowing.map((p, i) => (
                    <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm dark:border-amber-900 dark:bg-amber-950">
                      {p.desc}
                      <span className="ml-2 text-[11px] text-zinc-500">
                        {p.payoff_hint ? `回收线索：${p.payoff_hint} · ` : ""}
                        {p.latest_payoff_chapter ? `最迟第${p.latest_payoff_chapter}章` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {content?.resolve_foreshadowing && content.resolve_foreshadowing.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-green-600 dark:text-green-400">回收伏笔（置 closed）</h4>
                <ul className="flex flex-col gap-1">
                  {content.resolve_foreshadowing.map((r, i) => (
                    <li key={i} className="rounded-lg border border-green-200 bg-green-50 p-2 text-sm dark:border-green-900 dark:bg-green-950">
                      #{String(r.ledger_id ?? "").slice(0, 8)} — {r.how}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {content?.thread_updates && content.thread_updates.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">线索推进（入账）</h4>
                <ul className="flex flex-col gap-1">
                  {content.thread_updates.map((t, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      线索「{t.thread}」→ {t.new_state}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            </div>
          </div>
        )}
      </section>

      {/* ── 新增大纲弹窗（参考蓝图页「新增蓝图」/写作页「新增章节」：按钮 + Modal）。
           rewriteChapterNo != null 时是「重写本章」：章节号锁定，生成的是本章的新版本（与旧版本各自独立）。 ── */}
      <Modal
        open={showAddModal}
        title={rewriteChapterNo != null ? `重写第 ${rewriteChapterNo} 章大纲` : "新增大纲"}
        subtitle={
          rewriteChapterNo != null
            ? "重写本章：生成一个新版本（未批准），与本章已有版本各自独立、互不影响。批准新版本后，小说家写本章时才优先引用它。"
            : "大纲 = 单章的施工图。大纲师按当前生效蓝图，排出这一章的目标、节拍（beats）、冲突和视角。生成的是「未批准」版本，批准此版本后，小说家写这一章时会优先照它来。"
        }
        onClose={() => setShowAddModal(false)}
        maxWidth="max-w-xl"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="btn btn-ghost px-4 py-1.5"
            >
              取消
            </button>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline">
                <CostHint />
              </span>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating || !blueprintTitle}
                className="btn btn-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generating ? "生成中…" : rewriteChapterNo != null ? "重新生成大纲" : "生成大纲"}
              </button>
              {/* 点击生成后出现：打开生成过程弹窗（DeepSeek 风格，思考+正文流式滚动） */}
              {generating && (
                <button
                  type="button"
                  onClick={() => setShowStreamModal(true)}
                  className="btn btn-ghost px-3 py-1.5"
                >
                  查看生成过程
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {/* 无生效蓝图时提醒（新增大纲的前提）；有蓝图则不打扰 */}
          {!blueprintTitle && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-6 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              还没有生效的蓝图，无法生成大纲。
              <br />
              请先到「蓝图」页创建蓝图并设为生效，再回来新增大纲。
            </div>
          )}

          {/* 章节号不手动填写：打开弹窗时已自动推导（已有大纲最大章号 + 1，无则从第一卷第一章开始） */}
          <span className="text-[11px] text-zinc-400">
            {rewriteChapterNo != null ? (
              <>
                将重写：第 {rewriteChapterNo} 章
                {stage ? `（当前处于：${STAGE_LABEL[stage]}，视角角色按此过滤）` : ""}
              </>
            ) : (
              <>
                将自动生成：第 {form.chapter_no} 章
                {stage ? `（当前处于：${STAGE_LABEL[stage]}，视角角色按此过滤）` : ""}
              </>
            )}
          </span>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">视角角色</span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.pov}
              onChange={(e) => setForm({ ...form, pov: e.target.value })}
              disabled={generating}
            >
              <option value="">
                {activeCharacters.length > 0
                  ? "视角角色（留空由大纲师自定）"
                  : "该章节无生效角色（留空由大纲师自定）"}
              </option>
              {ROLE_RANKS.map((g) => {
                const items = activeCharacters.filter((c) => roleRankOf(c) === g.value);
                if (items.length === 0) return null;
                return (
                  <optgroup key={g.value} label={g.label}>
                    {items.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
              {activeCharacters.some((c) => !ROLE_RANKS.some((g) => roleRankOf(c) === g.value)) && (
                <optgroup label="未标注等级">
                  {activeCharacters
                    .filter((c) => !ROLE_RANKS.some((g) => roleRankOf(c) === g.value))
                    .map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              )}
              {inactiveCharacters.length > 0 && (
                <optgroup label="本章未生效（置灰不可选）">
                  {inactiveCharacters.map((c) => (
                    <option key={c.id} value={c.name} disabled>
                      {c.name}（{inactiveReason(c, form.chapter_no, volumes)}）
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">章节功能</span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.chapter_function}
              onChange={(e) => setForm({ ...form, chapter_function: e.target.value })}
              disabled={generating}
            >
              <option value="">章节功能：自动判定</option>
              {FUNCTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  章节功能：{l}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">本章目标</span>
            <textarea
              className="resize-none rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder="本章目标（goal，留空则由大纲师自行把握）"
              rows={2}
              value={form.goal}
              onChange={(e) => setForm({ ...form, goal: e.target.value })}
              disabled={generating}
            />
          </label>
          {/* 生成中的实时展示移入独立的「生成过程弹窗」（AgentStreamModal，参考蓝图页）。 */}
        </div>
      </Modal>

      {/* ── 版本选择弹窗：点击详情标题右侧的 vN 打开，列出本章全部版本，标明已批准项 ── */}
      <Modal
        open={showVersionModal}
        title={viewing ? `第 ${viewing.chapter_no} 章 · 选择大纲版本` : "选择大纲版本"}
        subtitle="同一章可保留多版大纲，点击版本可预览内容；已批准版本标 ✓。切换生效需在详情顶部点「批准此版本」。"
        onClose={() => setShowVersionModal(false)}
        maxWidth="max-w-lg"
        footer={
          <div className="flex w-full justify-end">
            <button
              type="button"
              onClick={() => setShowVersionModal(false)}
              className="btn btn-ghost px-4 py-1.5"
            >
              关闭
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          {versions.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-400">该章还没有任何大纲版本。</p>
          )}
          {versions.map((v) => {
            const active = v.id === viewing?.id;
            const approved = v.status === "approved";
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => {
                  setViewVersionId(v.id);
                  setShowVersionModal(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
                    : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                }`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 font-medium">
                    <span>v{v.version_no}</span>
                    {approved ? (
                      <span className="rounded bg-green-100 px-1.5 py-px text-[10px] text-green-700 dark:bg-green-900 dark:text-green-300">
                        ✓ 已批准
                      </span>
                    ) : (
                      <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        未批准
                      </span>
                    )}
                  </span>
                  {v.title && <span className="truncate text-xs text-zinc-500">{v.title}</span>}
                </span>
                <span className="shrink-0 text-[11px] text-zinc-400">
                  {new Date(v.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
            );
          })}
        </div>
      </Modal>

      {/* ── 生成过程弹窗：DeepSeek 网页版同款交互（复用公共组件，参考蓝图页） ── */}
      <AgentStreamModal
        open={showStreamModal}
        onClose={() => setShowStreamModal(false)}
        title="大纲师生成过程"
        running={generating}
        draftText={draftText}
        thinkingText={thinkingText}
        elapsed={elapsed}
        emptyRunningText={
          "模型正在深度思考与整理大纲（推理模型思考期约 1-3 分钟，此阶段通常没有正文输出），\n正文开始生成后会在这里实时滚动显示…"
        }
        emptyDoneText="生成完成，新大纲已作为未批准版本落库，可在详情里批准此版本。"
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
