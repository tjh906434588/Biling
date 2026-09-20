"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  getActiveBlueprint,
  getChapter,
  listChapters,
  listOutlines,
  listReviews,
  runAgent,
  selectVersion,
  type Blueprint,
  type ChapterDetail,
  type ChapterListItem,
  type Outline,
  type QualityReview,
  type SettingGap,
  type StreamTaskInfo,
} from "@/lib/api";
import InfoTip from "./info-tip";
import Modal from "./modal";
import AiRunDialog from "./agent-run-dialog";
import Loading from "@/components/loading";
import { message } from "@/components/message";
import { notification, closeNotification, removeNotification } from "@/components/notification";
import { CostHint, useAiStatus } from "@/lib/ai-status";

interface Props {
  novelId: string;
}

interface GenForm {
  chapter_no: number;
  title: string;
  outline: string;
  chapter_function: string;
  writing_mode: string;
  goal: string;
  reader_knows: string;
  protagonist_knows: string;
  must_hide: string;
  hint_only: string;
}

/** AI 运行过程状态：供「查看 AI 过程」弹窗流式展示（thinking=思考过程 / output=正式输出）。 */
interface AiRunState {
  thinking: string;
  output: string;
  running: boolean;
}

/** 下游受影响章节（递进链被根部改动波及）：每项带关系信息，前端据此展示「是什么影响到了这章」。
 *  origin_chapter / origin_relation 是被删/改的根因（如第1章 师徒），relation 是该章受影响的关系。 */
interface AffectedChapter {
  chapter_no: number;
  source: string;
  target: string;
  relation: string;
  origin_chapter: number;
  origin_relation: string;
}

/** 受影响章节 → 全局 Notification 的模块级状态（跨写作页卸载/切页存活）：
 *  通知悬浮在右上角、常驻，切页不隐藏；只有点 ✕ 或「挨个重写」才关闭（与新手引导不同，不随页面隐藏）。
 *  组件卸载时不清理通知，数据存在这里，切页回来由组件初始状态还原。 */
let affectedNotifId: number | null = null;
let affectedData: AffectedChapter[] | null = null;
let affectedNovelId: string | null = null;
let affectedRerun: (() => void) | null = null;
let affectedClear: (() => void) | null = null;

/** 联动重写中断 → 全局 Notification 的模块级状态（跨写作页卸载/切页存活）：
 *  error 类型、无 ✕（closable:false），只能自动关闭；
 *  总展示 15s，但只累计「页面可见时间」：离开页面暂停并保留剩余时长，回来继续累计，
 *  刷新从 localStorage 恢复数据与剩余，直到累计满 15s 才自动关闭（通知继续显示、不清除）。 */
interface RewriteFailData {
  failedChapter: number;
  remainingRewrite: number[];
  remainingExtract: number[];
}
const REWRITE_FAIL_TOTAL_MS = 15_000;
let rewriteNotifId: number | null = null;
let rewriteFailData: RewriteFailData | null = null;
let rewriteNovelId: string | null = null;
let rewriteRemainingMs = 0;

function rewriteFailDataKey(novelId: string) {
  return `biling.rewriteFail.${novelId}.data`;
}
function rewriteFailRemainingKey(novelId: string) {
  return `biling.rewriteFail.${novelId}.remaining`;
}
/** 刷新后恢复中断数据（模块变量已重置，只能从 localStorage 读）。 */
function loadRewriteFailData(novelId: string): RewriteFailData | null {
  try {
    const raw = localStorage.getItem(rewriteFailDataKey(novelId));
    if (!raw) return null;
    const d = JSON.parse(raw) as RewriteFailData;
    if (
      typeof d.failedChapter === "number" &&
      Array.isArray(d.remainingRewrite) &&
      Array.isArray(d.remainingExtract)
    ) {
      return d;
    }
  } catch {
    /* 忽略损坏数据 */
  }
  return null;
}
function saveRewriteFailData(novelId: string, data: RewriteFailData | null) {
  try {
    if (data) localStorage.setItem(rewriteFailDataKey(novelId), JSON.stringify(data));
    else localStorage.removeItem(rewriteFailDataKey(novelId));
  } catch {
    /* 忽略 */
  }
}
/** 刷新后恢复剩余展示时长（页面可见时才递减）。 */
function loadRewriteRemaining(novelId: string): number {
  try {
    const v = Number(localStorage.getItem(rewriteFailRemainingKey(novelId)));
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    /* 忽略 */
  }
  return 0;
}
function saveRewriteRemaining(novelId: string, ms: number) {
  try {
    if (ms > 0) localStorage.setItem(rewriteFailRemainingKey(novelId), String(Math.round(ms)));
    else localStorage.removeItem(rewriteFailRemainingKey(novelId));
  } catch {
    /* 忽略 */
  }
}

/** 用当前模块数据渲染联动重写中断通知（rewriteNovelId/rewriteFailData 需已设置）。
 *  剩余展示时长：切页/离开回来优先取 localStorage，无则用模块剩余，再否则满额 15s。
 *  只在当前小说工作台显示：离开工作台由 hideWorkspaceNotifs 隐藏（暂停计时、数据保留），回来重弹续计。 */
function renderRewriteFailNotif(novelId: string) {
  const data = rewriteFailData;
  if (!data) return;
  const persisted = loadRewriteRemaining(novelId);
  rewriteRemainingMs = persisted > 0 ? persisted : rewriteRemainingMs > 0 ? rewriteRemainingMs : REWRITE_FAIL_TOTAL_MS;
  saveRewriteRemaining(novelId, rewriteRemainingMs);
  saveRewriteFailData(novelId, data);
  rewriteNotifId = notification.error({
    duration: 0, // 不由通知组件自动关（计时在 WritingPanel 内，只累计页面可见时间）
    closable: false, // 无 ✕：只能自动关闭
    title: "联动重写中断",
    message: (
      <div className="space-y-2">
        {/* 根因 */}
        <div className="rounded-md bg-red-100/80 px-2.5 py-1.5 dark:bg-red-900/50">
          <p className="text-[12px] font-semibold leading-5 text-red-900 dark:text-red-100">根因</p>
          <p className="mt-0.5 text-[12px] leading-5 text-red-800/90 dark:text-red-200/90">
            第 <span className="font-medium">{data.failedChapter}</span> 章处理失败，联动已停止；
            失败之后还没轮到处理的章节同样未完成，请到章节目录手动补齐。
          </p>
        </div>
        {/* 未完成清单 */}
        <div>
          <p className="text-[12px] font-semibold leading-5 text-red-900 dark:text-red-100">未完成事项</p>
          <ul className="mt-1 space-y-1 text-[12px] leading-5 text-red-800/90 dark:text-red-200/90">
            {data.remainingRewrite.length > 0 && (
              <li className="rounded-md bg-red-100/70 px-2 py-1 dark:bg-red-900/50">
                正文未重写：第 <span className="font-medium">{data.remainingRewrite.join("、")}</span> 章
                （请「重新生成正文」）
              </li>
            )}
            {data.remainingExtract.length > 0 && (
              <li className="rounded-md bg-red-100/70 px-2 py-1 dark:bg-red-900/50">
                记忆层未提取：第 <span className="font-medium">{data.remainingExtract.join("、")}</span> 章
                （请点「提取 → 记忆层」）
              </li>
            )}
          </ul>
        </div>
      </div>
    ),
    onClose: () => {
      // 15s 计时耗尽由 closeNotification 触发（无 ✕，不会手动触发）：清模块态
      rewriteNotifId = null;
      rewriteFailData = null;
      rewriteNovelId = null;
    },
  });
}

/**
 * 进入当前小说工作台（WorkspacePage 挂载）：恢复本小说挂着的常驻/计时通知——
 *  「后续章节关系受影响」与「联动重写中断」只在当前小说工作台显示，各小说互相独立：
 *  离开本小说工作台即隐藏（不清数据），回来重新弹出；其他小说的数据不受影响。
 *  联动重写中断带刷新持久化（localStorage），刷新后即便停在非写作 tab 也能恢复显示（计时由写作页恢复后继续）。
 */
export function showWorkspaceNotifs(novelId: string) {
  if (affectedNovelId === novelId && affectedData && affectedNotifId == null) renderAffectedNotif();
  // 中断通知：模块数据在刷新后可能丢失，从 localStorage 兜底恢复
  if (rewriteNotifId == null) {
    const data = rewriteNovelId === novelId ? rewriteFailData : loadRewriteFailData(novelId);
    if (data) {
      rewriteNovelId = novelId;
      rewriteFailData = data;
      renderRewriteFailNotif(novelId);
    }
  }
}

/** 离开当前小说工作台（WorkspacePage 卸载）：隐藏本小说的两条通知，不触发 onClose（不误判为已处理），数据保留。 */
export function hideWorkspaceNotifs(novelId: string) {
  if (affectedNotifId != null && affectedNovelId === novelId) {
    removeNotification(affectedNotifId);
    affectedNotifId = null;
  }
  if (rewriteNotifId != null && rewriteNovelId === novelId) {
    removeNotification(rewriteNotifId);
    rewriteNotifId = null;
  }
}

/** 受影响章节按章分组（逐章展示对应关系）。 */
function groupAffectedByChapter(list: AffectedChapter[]): [number, AffectedChapter[]][] {
  const map = new Map<number, AffectedChapter[]>();
  for (const a of list) {
    const arr = map.get(a.chapter_no) ?? [];
    arr.push(a);
    map.set(a.chapter_no, arr);
  }
  return [...map.entries()].sort((x, y) => x[0] - y[0]);
}

/**
 * 把受影响状态同步到模块级并渲染/刷新通知：
 * - chapters 为空 → 关闭本小说正在显示的通知（点按钮 / ✕ 走这里）；
 * - 同一份数据重复同步（如切页回来重新挂载）→ 只更新回调，不重弹；
 * - 数据更新（再次提取）→ 先移除旧的再重弹，始终反映最新受影响清单。
 */
function syncAffectedNotif(
  novelId: string,
  chapters: AffectedChapter[] | null,
  rerun: () => void,
  clear: () => void,
) {
  affectedRerun = rerun;
  affectedClear = clear;
  const active = chapters && chapters.length > 0 ? chapters : null;

  if (!active) {
    // 本地已清（点按钮 / ✕）：只关闭本小说的通知；其他小说挂着的通知与数据不受影响
    if (affectedNotifId != null && affectedNovelId === novelId) {
      closeNotification(affectedNotifId);
      affectedNotifId = null;
      affectedData = null;
    }
    return;
  }
  // 同一份数据（切页回来重新挂载）：仅更新回调，不重复弹
  if (affectedNotifId != null && affectedData === active) return;

  // 数据更新（再次提取）：先移除旧的再重弹，始终反映最新受影响清单
  if (affectedNotifId != null) {
    removeNotification(affectedNotifId);
    affectedNotifId = null;
  }
  affectedNovelId = novelId;
  affectedData = active;
  renderAffectedNotif();
}

/** 用当前模块数据渲染受影响章节通知（affectedNovelId/affectedData 需已设置）。
 *  只在当前小说工作台显示：离开工作台由 hideWorkspaceNotifs 隐藏（不清数据），回来由 showWorkspaceNotifs 重弹。 */
function renderAffectedNotif() {
  const active = affectedData;
  if (!active || active.length === 0) return;
  const byChapter = groupAffectedByChapter(active);
  const originChapter = active[0].origin_chapter;
  const originRelations = [...new Set(active.map((a) => a.origin_relation).filter(Boolean))];

  affectedNotifId = notification.warning({
    duration: 0, // 常驻：不自动消失、不被其他通知顶掉
    title: "后续章节关系受影响",
    message: (
      <div className="space-y-2">
        {/* 根因 */}
        <div className="rounded-md bg-amber-100/80 px-2.5 py-1.5 dark:bg-amber-900/50">
          <p className="text-[12px] font-semibold leading-5 text-amber-900 dark:text-amber-100">根因</p>
          <p className="mt-0.5 text-[12px] leading-5 text-amber-800/90 dark:text-amber-200/90">
            第 {originChapter} 章的
            {originRelations.length > 0 ? originRelations.map((r) => `「${r}」`).join("、") : "关系"}
            被删除/替换，以下章节的正文仍建立在旧递进链上，需按各章当前大纲重写并重新提取记忆层。
          </p>
        </div>
        {/* 受影响章节清单 */}
        <div>
          <p className="text-[12px] font-semibold leading-5 text-amber-900 dark:text-amber-100">
            受影响章节（{byChapter.length} 章）
          </p>
          <ul className="mt-1 space-y-1 text-[12px] leading-5 text-amber-800/90 dark:text-amber-200/90">
            {byChapter.map(([no, items]) => (
              <li
                key={no}
                className="flex items-baseline gap-1.5 rounded-md bg-amber-100/70 px-2 py-1 dark:bg-amber-900/50"
              >
                <span className="shrink-0 font-medium text-amber-900 dark:text-amber-100">第 {no} 章</span>
                <span className="min-w-0">
                  {items.map((a) => `${a.source} ${a.relation} ${a.target}`).join("、")}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {/* 操作 */}
        <button
          type="button"
          onClick={() => {
            // 先触发联动重写（内部会 setAffectedChapters(null) 关通知），再兜底关闭本通知
            affectedRerun?.();
            if (affectedNotifId != null) {
              closeNotification(affectedNotifId);
              affectedNotifId = null;
            }
          }}
          className="w-full rounded-lg bg-amber-700 px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-amber-800 dark:bg-amber-600 dark:hover:bg-amber-500"
        >
          挨个重写第 {byChapter.map(([no]) => no).join("、")} 章并重提取
        </button>
      </div>
    ),
    onClose: () => {
      // ✕ 手动关闭 = 暂不处理：清掉模块状态 + 组件本地状态，避免效果重跑再弹
      affectedNotifId = null;
      affectedData = null;
      const clearFn = affectedClear;
      affectedRerun = null;
      affectedClear = null;
      clearFn?.();
    },
  });
}

/** 章节功能：写作页与大纲页共用同一份，保证两处下拉完全一致（默认空 = 自动判定）。 */
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
  title: "",
  outline: "",
  chapter_function: "", // 留空 = 由小说家按剧情节奏自动判定（与大纲页一致）
  writing_mode: "outline_guided",
  goal: "",
  reader_knows: "",
  protagonist_knows: "",
  must_hide: "",
  hint_only: "",
};

/** 卷信息（与蓝图 content.volumes 一致，用于章节目录按卷分组）。 */
type VolumeInfo = NonNullable<Blueprint["content"]["volumes"]>[number];

interface ChapterVolumeGroup {
  key: string;
  label: string;
  subtitle: string;
  items: ChapterListItem[];
}

/** 把章节按当前生效蓝图的 volumes（chapters_range）归组；不在任何卷内的归「未分卷/全部章节」。
 *  与大纲页 groupByVolume 逻辑一致，只是 item 换成 ChapterListItem。 */
/** 蓝图没有分卷（或卷的章节范围全无法解析）时的兜底卷：所有章节归入「第1卷」（与大纲页一致）。 */
const DEFAULT_VOLUME: VolumeInfo = { no: 1, name: "", focus: "", chapters_range: "" };

function groupChaptersByVolume(
  chapters: ChapterListItem[],
  volumes: VolumeInfo[] | undefined,
): ChapterVolumeGroup[] {
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

  const groups: ChapterVolumeGroup[] = effectiveVols.map((v) => ({
    key: `vol-${v.no ?? v.name ?? "?"}`,
    label: `${v.no != null ? `第${v.no}卷` : "卷"}${v.name ? ` · ${v.name}` : ""}`,
    subtitle: [v.chapters_range && `${v.chapters_range}章`, v.chapter_count, v.word_count]
      .filter(Boolean)
      .join(" · "),
    items: [],
  }));
  const rest: ChapterVolumeGroup = {
    key: "rest",
    label: "未分卷",
    subtitle: "",
    items: [],
  };

  for (const c of [...chapters].sort((a, b) => a.chapter_no - b.chapter_no)) {
    const hit = effectiveParsed.find(({ start, end }) => c.chapter_no >= start && c.chapter_no <= end);
    const target = hit
      ? groups.find((g) => g.key === `vol-${hit.v.no ?? hit.v.name ?? "?"}`)
      : undefined;
    (target ?? rest).items.push(c);
  }

  const result = groups.filter((g) => g.items.length > 0);
  if (rest.items.length > 0) result.push(rest);
  return result;
}

/** 版本来源的友好标签（章节详情版本列表用）。 */
const SOURCE_LABELS: Record<string, string> = {
  novelist: "初稿",
  reviser: "按评价优化",
  merged: "手动合并",
};

function sourceLabel(source: string): string {
  if (source.startsWith("novelist")) return "初稿";
  return SOURCE_LABELS[source] ?? source;
}

/** 自动增高文本框：高度跟随内容，封顶后内部滚动（用于「本章大纲目标」）。 */
function AutoTextarea({
  value,
  onChange,
  placeholder,
  className,
  maxHeight = 320,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    />
  );
}

export default function WritingPanel({ novelId }: Props) {
  // 初始数据（章节目录 / 已批准大纲 / 卷结构）加载中：遮罩过渡
  const [loading, setLoading] = useState(true);
  const [chapters, setChapters] = useState<ChapterListItem[]>([]);
  /** 当前生效蓝图的卷列表：章节目录按卷分组、可展开/搜索（与大纲页一致）。 */
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  /** 章节目录搜索词（按章号/标题过滤）。 */
  const [chapterSearch, setChapterSearch] = useState("");
  /** 被折叠的卷 key（默认全展开）。搜索时强制展开匹配卷。 */
  const [collapsedVols, setCollapsedVols] = useState<Record<string, boolean>>({});
  const [activeNo, setActiveNo] = useState<number | null>(null);
  const [detail, setDetail] = useState<ChapterDetail | null>(null);
  const [form, setForm] = useState<GenForm>(EMPTY_FORM);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 正上方悬浮条已迁移到全局 Message：showToast 为本地别名，统一走 message API。 */
  const showToast = (msg: string, level: "success" | "warning" | "error" = "success") => {
    if (level === "error") message.error(msg);
    else if (level === "warning") message.warning(msg);
    else message.success(msg);
  };
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState<string | null>(null);
  /** 本次提取清掉的「链条中间环」所影响的下游章节（如删了第1章 师徒，第2/3章递进前提断裂）。
   *  提取回执带 downstream_affected 时置位，弹出右上角全局 Notification 提示作者「挨个重写并重提取」；
   *  暂不处理（✕）/开始处理后清空。切页后通知保持显示，回来时从模块级状态还原（不会因切页丢失）。 */
  const [affectedChapters, setAffectedChapters] = useState<AffectedChapter[] | null>(() =>
    affectedNovelId === novelId && affectedData ? affectedData : null,
  );
  /** 串行联动重写中断（任一章重写或提取失败即停止）：记录失败章 + 仍未完成的章节，
   *  弹右上角 error 通知分章列出「正文未重写 / 记忆层未提取」，让作者手动逐章补齐。
   *  初始状态还原模块级数据（切页回来），刷新则从 localStorage 恢复。 */
  const [rewriteFail, setRewriteFail] = useState<RewriteFailData | null>(() =>
    rewriteNovelId === novelId && rewriteFailData ? rewriteFailData : loadRewriteFailData(novelId),
  );
  const [approvedOutline, setApprovedOutline] = useState<Outline | null>(null);
  const [approvedOutlines, setApprovedOutlines] = useState<Outline[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [reviews, setReviews] = useState<QualityReview[] | null>(null);
  /** AI 运行过程（「查看 AI 过程」弹窗）：生成正文 / 评价 / 优化各一份，任务结束保留供回看。 */
  const [genRun, setGenRun] = useState<AiRunState | null>(null);
  const [showGenRun, setShowGenRun] = useState(false);
  const [reviewRun, setReviewRun] = useState<AiRunState | null>(null);
  const [showReviewRun, setShowReviewRun] = useState(false);
  const [reviseRun, setReviseRun] = useState<AiRunState | null>(null);
  const [showReviseRun, setShowReviseRun] = useState(false);
  /**
   * 写后设定自检命中的疑似漏项：蓝图/设定里要求「成组同时出现」的内容只写了一部分
   * （如面板必须 天赋清单+兴趣爱好+适配推荐，正文漏了「兴趣爱好」）。
   * 由后端 SSE setting_warning 事件下发，属提示性质，不阻断成文。
   */
  const [settingGaps, setSettingGaps] = useState<SettingGap[] | null>(null);

  /** 记忆层提取时记录：提取的是哪一章的哪个版本（id）。用于判断「当前正文」是否与提取的不一致，
   *  一致则无需重提取，不一致则高亮「提取→记忆层」按钮提醒用户重新提取。
   *  按章节隔离：切换章节后只对当前章做对比，不会把上一章的提取状态误带到本章。 */
  const [extractedChapterNo, setExtractedChapterNo] = useState<number | null>(null);
  const [extractedVersionId, setExtractedVersionId] = useState<string | null>(null);

  // 弹窗开关
  const [showAddModal, setShowAddModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  /** 重新生成模式：非 null 时新增章节弹窗以"重新生成当前章正文"语义工作（章节号锁定当前章）。 */
  const [regenerateNo, setRegenerateNo] = useState<number | null>(null);

  /** 信息控制弹窗：本地 draft，点「完成」才提交到 form，点「取消」丢弃。
   *  这样「清空」只清本地草稿，不点确定则原内容仍然保留（再打开还在）。 */
  const [infoDraft, setInfoDraft] = useState<{
    reader_knows: string;
    protagonist_knows: string;
    must_hide: string;
    hint_only: string;
  }>({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
  const openInfoModal = useCallback(() => {
    setInfoDraft({
      reader_knows: form.reader_knows,
      protagonist_knows: form.protagonist_knows,
      must_hide: form.must_hide,
      hint_only: form.hint_only,
    });
    setShowInfoModal(true);
  }, [form]);

  const { ensureReady } = useAiStatus();

  /** 将已批大纲压缩成一段可作 outline 参数 / 评价对照的摘要（不含标题，标题单独成字段）。 */
  function summarizeOutline(o: Outline): string {
    const c = (o.content ?? {}) as {
      goal?: string;
      beats?: Array<{ content?: string }>;
      plant_foreshadowing?: Array<{ desc?: string; latest_payoff_chapter?: number }>;
      resolve_foreshadowing?: Array<{ how?: string }>;
    };
    const parts: string[] = [];
    if (c.goal) parts.push(`目标：${c.goal}`);
    if (c.beats?.length) parts.push(`节拍：${c.beats.map((b) => b.content).filter(Boolean).join("；").slice(0, 400)}`);
    if (c.plant_foreshadowing?.length)
      parts.push(`埋设：${c.plant_foreshadowing.map((p) => p.desc).join("、")}`);
    if (c.resolve_foreshadowing?.length)
      parts.push(`回收：${c.resolve_foreshadowing.map((r) => r.how).join("、")}`);
    return parts.join("\n");
  }

  /**
   * 目录里「最新一章」的下一章号：新增永远只追加最新的一章，不允许跳号或回填旧章。
   * 大纲约束模式下该章必须有已批大纲才能生成；自由草稿模式无此限制。
   */
  const maxChapterNo = chapters.reduce((m, c) => Math.max(m, c.chapter_no), 0);
  const nextNo = maxChapterNo + 1;
  const targetOutline =
    form.writing_mode === "outline_guided"
      ? approvedOutlines.find((o) => o.chapter_no === form.chapter_no) ?? null
      : null;
  const canAdd = form.writing_mode === "draft_free" || targetOutline != null;
  const infoFilledCount = [form.reader_knows, form.protagonist_knows, form.must_hide, form.hint_only].filter(
    (v) => v.trim(),
  ).length;

  /** 打开「新增章节」弹窗：按当前目录算好目标章号、回填该章已批大纲（若有）。 */
  const openAddModal = useCallback(() => {
    const o =
      form.writing_mode === "outline_guided"
        ? approvedOutlines.find((x) => x.chapter_no === nextNo) ?? null
        : null;
    setForm((f) => ({
      ...f,
      chapter_no: nextNo,
      title: o ? o.title ?? "" : "",
      outline: o ? summarizeOutline(o) : "",
      chapter_function: "",
    }));
    setRegenerateNo(null);
    setShowAddModal(true);
  }, [approvedOutlines, form.writing_mode, nextNo]);

  /** 打开「重新生成正文」弹窗：复用新增章节弹窗，章节号锁定为当前章，其余字段可改。
   *  后端 _persist_novelist 会基于该 chapter_no 追加一个新版本并自动定稿。 */
  const openRegenerateModal = useCallback(() => {
    if (activeNo == null) return;
    const o = approvedOutlines.find((x) => x.chapter_no === activeNo) ?? null;
    setForm((f) => ({
      ...f,
      chapter_no: activeNo,
      title: detail?.title ?? o?.title ?? "",
      outline: o ? summarizeOutline(o) : "",
      chapter_function: "",
      writing_mode: o ? "outline_guided" : "draft_free",
    }));
    setRegenerateNo(activeNo);
    setShowAddModal(true);
  }, [approvedOutlines, activeNo, detail]);

  /** 弹窗内切换写作模式：同步重算目标章号与大纲回填。 */
  function changeWritingMode(mode: string) {
    const o = mode === "outline_guided" ? approvedOutlines.find((x) => x.chapter_no === nextNo) ?? null : null;
    setForm((f) => ({
      ...f,
      writing_mode: mode,
      chapter_no: nextNo,
      title: o ? o.title ?? "" : "",
      outline: o ? summarizeOutline(o) : "",
      chapter_function: "",
    }));
  }

  const loadApprovedOutlines = useCallback(
    async (no?: number) => {
      try {
        const list = await listOutlines(novelId, "approved");
        const sorted = [...list].sort((a, b) => a.chapter_no - b.chapter_no);
        setApprovedOutlines(sorted);
        const hit =
          no != null ? (sorted.find((o) => o.chapter_no === no) ?? null) : (sorted[sorted.length - 1] ?? null);
        setApprovedOutline(hit);
      } catch {
        setApprovedOutline(null);
      }
    },
    [novelId],
  );

  const loadChapters = useCallback(async () => {
    try {
      setChapters(await listChapters(novelId));
    } catch (e) {
      // 章节加载失败不内联显示，走顶部悬浮框提示
      message.error((e as Error).message);
    }
  }, [novelId]);

  const loadDetail = useCallback(
    async (no: number) => {
      try {
        setDetail(await getChapter(novelId, no));
      } catch (e) {
        const msg = (e as Error).message;
        // 章节正文尚未生成（如大纲已批准但正文还没生成/上次生成未落库）→ 静默，不报红色错误
        if (msg.includes("404")) {
          setDetail(null);
        } else {
          // 章节详情加载失败不内联显示，走顶部悬浮框提示
          message.error(msg);
        }
      }
      void loadApprovedOutlines(no);
      try {
        setReviews(await listReviews(novelId, no));
      } catch {
        setReviews(null);
      }
    },
    [novelId, loadApprovedOutlines],
  );

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([
          loadChapters(),
          loadApprovedOutlines(), // 默认：大纲约束 + 最新一章章节大纲
          // 拉取当前生效蓝图，用于章节目录按卷分组
          getActiveBlueprint(novelId)
            .then((bp) => setVolumes(bp?.content?.volumes ?? []))
            .catch(() => setVolumes([])),
        ]);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadChapters, loadApprovedOutlines, novelId]);

  // 后台任务（跨页/刷新恢复）由全局 AgentTaskToasts 轮询并提示；完成后派发
  // biling:agent-task-done 事件，这里负责刷新目录/正文，保持"自动落库并刷新"的行为
  useEffect(() => {
    const onDone = (e: Event) => {
      const task = (e as CustomEvent<{ task?: StreamTaskInfo }>).detail?.task;
      void loadChapters();
      if (task?.chapter_no != null) void loadDetail(task.chapter_no);
    };
    window.addEventListener("biling:agent-task-done", onDone);
    return () => window.removeEventListener("biling:agent-task-done", onDone);
  }, [loadChapters, loadDetail]);

  const activeChapter = chapters.find((c) => c.chapter_no === activeNo) ?? null;
  /** 当前激活（选中）的正文版本，用于把评价对齐到"你现在看到的这一版"。 */
  const activeVersion = detail?.versions.find((v) => v.is_active) ?? null;
  /** 只保留对得上当前正文的评价；接口已按时间倒序，取第一条即最近一次。 */
  const currentReviews = (reviews ?? []).filter((r) => r.is_current);
  const currentReview = currentReviews[0] ?? null;
  /** 当前定稿正文还没有评价 → 「评价本章」按钮高亮提醒。
   *  reviews 为 null 表示评价还没加载完，此时一律不高亮，避免切换章节时的高亮闪烁。 */
  const reviewPending =
    !!activeChapter?.active_content && reviews != null && !currentReview;
  /** 右侧正文区是否"有内容"：有正文版本或已选中某章时为 true → 撑满页面高度；
   *  无内容（未选章）时为 false → 自然高度，不让它强行占满整屏，也不反向把左侧模块带高。 */
  const hasContent = detail != null || activeNo != null;
  /** 当前定稿正文还没提取过记忆层 → 高亮「提取→记忆层」。
   *  判定依据（任一命中即视为"已提取"，不高亮）：
   *    1. 本会话刚提取过当前章/当前版本（即时反馈）；
   *    2. 持久化的提取记录（story_state.chapter_version_id）== 当前激活版本（刷新后仍准确）。
   *  activeVersion 尚未加载（null）时不高亮，避免切换章节时闪烁。 */
  const extractedMatch =
    (extractedChapterNo === activeNo && extractedVersionId === activeVersion?.id) ||
    (activeChapter?.extracted_version_id != null &&
      activeChapter.extracted_version_id === activeVersion?.id);
  const extractPending =
    !!activeChapter?.active_content && activeVersion != null && !extractedMatch;

  /** 章节目录按卷分组（搜索为空时按卷归组；搜索时仅过滤、不折叠）。 */
  const volGroups = groupChaptersByVolume(chapters, volumes);
  const chapterQ = chapterSearch.trim().toLowerCase();
  const chapterMatches = (c: ChapterListItem) =>
    !chapterQ || `第${c.chapter_no}章 ${c.title ?? ""}`.toLowerCase().includes(chapterQ);

  /** 「挨个重写」始终指向最新一次渲染的联动重写逻辑，避免通知里回调闭包过期。 */
  const rerunAffectedRef = useRef<() => void>(() => {});
  rerunAffectedRef.current = () => handleRerunAffected();

  /** 受影响章节 → 全局 Notification（右上角、常驻）：状态置位时弹出；切页不隐藏，
   *  只有点 ✕ 或「挨个重写」才关闭（组件卸载不清通知，由模块级持有，回来时状态还原）。
   *  点「挨个重写」（handleRerunAffected 先 setAffectedChapters(null)）或点 ✕ 后通知即关闭。 */
  useEffect(() => {
    syncAffectedNotif(novelId, affectedChapters, () => rerunAffectedRef.current(), () =>
      setAffectedChapters(null),
    );
  }, [novelId, affectedChapters]);

  /** 联动重写中断 → 全局 Notification（右上角、error 类型、不可手动关闭）：
   *  - 状态置位时弹通知（数据更新先移除旧的再重弹），切页不隐藏、回来状态还原（同上，模块级持有）；
   *  - 15s 总展示时长只累计「页面可见时间」：document 不可见/组件卸载时暂停并保留剩余（写 localStorage），
   *    刷新或切页回来继续累计，累计满 15s 才自动关闭（此时才清模块态与本地状态）。 */
  useEffect(() => {
    if (!rewriteFail) {
      // 本地清空（如新一轮联动开始前 setRewriteFail(null)）：关闭本小说的通知并清理持久化，
      // 剩余时长归零，保证下一次失败重新从满额 15s 计时
      if (rewriteNotifId != null && rewriteNovelId === novelId) {
        closeNotification(rewriteNotifId);
        rewriteNotifId = null;
        rewriteFailData = null;
        rewriteNovelId = null;
        saveRewriteFailData(novelId, null);
      }
      rewriteRemainingMs = 0;
      saveRewriteRemaining(novelId, 0);
      return;
    }
    // 通知尚未弹 / 数据已更新 / 属于其他小说：先移除旧的再重弹（渲染逻辑统一在模块函数 renderRewriteFailNotif）
    if (rewriteNotifId == null || rewriteNovelId !== novelId || rewriteFailData !== rewriteFail) {
      if (rewriteNotifId != null) removeNotification(rewriteNotifId);
      rewriteNovelId = novelId;
      rewriteFailData = rewriteFail;
      renderRewriteFailNotif(novelId);
    }
    // 倒计时：每秒递减「页面可见时间」，攒满 15s 自动关闭
    const id = rewriteNotifId;
    if (id == null) return;
    // 剩余时长来源：优先取 localStorage（按小说隔离，刷新/切页/换小说回来都不丢）；
    // 无持久化则用模块剩余，再否则满额 15s
    const persisted = loadRewriteRemaining(novelId);
    if (persisted > 0) rewriteRemainingMs = persisted;
    else if (rewriteRemainingMs <= 0) rewriteRemainingMs = REWRITE_FAIL_TOTAL_MS;
    saveRewriteRemaining(novelId, rewriteRemainingMs);
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      if (document.visibilityState === "visible") {
        rewriteRemainingMs -= now - last;
        if (rewriteRemainingMs <= 0) {
          rewriteRemainingMs = 0;
          saveRewriteRemaining(novelId, 0);
          saveRewriteFailData(novelId, null);
          closeNotification(id);
          rewriteNotifId = null;
          rewriteFailData = null;
          rewriteNovelId = null;
          setRewriteFail(null);
          return;
        }
        saveRewriteRemaining(novelId, rewriteRemainingMs);
      }
      last = now;
    };
    const iv = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(iv);
      // 卸载/切页：暂停计时，剩余时长持久化（通知保持显示，回来继续累计）
      saveRewriteRemaining(novelId, rewriteRemainingMs);
    };
  }, [novelId, rewriteFail]);

  async function handleGenerate() {
    setGenerating(true);
    setExtractResult(null);
    setSettingGaps(null);
    // 弹窗保持打开、不自动关闭；生成过程通过「查看 AI 过程」按钮实时查看
    setGenRun({ thinking: "", output: "", running: true });

    const infoControl: Record<string, string> = {};
    for (const [k, v] of [
      ["reader_knows", form.reader_knows],
      ["protagonist_knows", form.protagonist_knows],
      ["must_hide", form.must_hide],
      ["hint_only", form.hint_only],
    ] as const) {
      if (v.trim()) infoControl[k] = v.trim();
    }

    const params: Record<string, unknown> = {
      chapter_no: form.chapter_no,
      title: form.title.trim() || undefined,
      outline: form.outline.trim() || undefined,
      chapter_function: form.chapter_function || undefined, // 空 = 交给小说家自动判定
      writing_mode: form.writing_mode,
      goal: form.goal.trim() || undefined,
    };
    if (Object.keys(infoControl).length > 0) params.info_control = infoControl;

    try {
      ensureReady();
      await runAgent("novelist", novelId, params, (ev) => {
        const d = ev.data as {
          delta?: string;
          status?: string;
          message?: string;
          action?: string;
        };
        if (ev.event === "thinking_delta" && d.delta) {
          setGenRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
        } else if (ev.event === "stream_delta" && d.delta) {
          setGenRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
        } else if (ev.event === "stored") {
          const action = d.action as string | undefined;
          if (action === "alert") {
            showToast(
              `第 ${form.chapter_no} 章生成内容未通过格式校验（已记录告警）。可点「生成正文」重试。`,
              "error",
            );
          } else if (action !== "dry_run") {
            showToast(
              `第 ${form.chapter_no} 章新版本已生成并自动定稿。想换回旧版，请在下方章节详情点选历史版本。`,
              "success",
            );
          }
        } else if (ev.event === "setting_warning") {
          const items = (ev.data as { items?: SettingGap[] }).items ?? [];
          setSettingGaps(items.length ? items : null);
        } else if (ev.event === "stream_error") {
          showToast(d.message ?? "AI 生成出错，请稍后重试。", "error");
        }
      });
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setGenerating(false);
      setGenRun((r) => (r ? { ...r, running: false } : r));
      setActiveNo(form.chapter_no);
      await loadChapters();
      await loadDetail(form.chapter_no);
    }
  }

  async function handleSelectVersion(versionId: string) {
    if (!detail) return;
    // 自己点自己（当前已定稿版本）：无意义，直接忽略，不处理也不弹提示
    const target = detail.versions.find((v) => v.id === versionId);
    if (target?.is_active) return;
    try {
      const updated = await selectVersion(novelId, detail.chapter_no, versionId);
      setDetail(updated);
      // 页面正上方悬浮条（最新一条顶掉旧的），不再用含糊的蓝色横幅
      showToast(`已切换到第 ${updated.chapter_no} 章定稿正文（v${activeVersionOf(updated)} · ${sourceLabel(versionOf(updated, versionId))}）`, "success");
      await loadChapters();
      try {
        setReviews(await listReviews(novelId, updated.chapter_no));
      } catch {
        setReviews(null);
      }
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  }

  function versionOf(d: ChapterDetail, versionId: string): string {
    return d.versions.find((v) => v.id === versionId)?.source ?? "?";
  }
  function activeVersionOf(d: ChapterDetail): number {
    return d.versions.find((v) => v.is_active)?.version_no ?? 0;
  }

  async function handleCopyContent() {
    if (!activeChapter?.active_content) return;
    try {
      await navigator.clipboard.writeText(activeChapter.active_content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast("复制失败，请手动选中正文复制。", "error");
    }
  }

  async function handleExtract() {
    if (!activeChapter) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!activeChapter.active_content) {
      showToast("该章尚未选定版本，无法提取。请先完成生成与选定。", "warning");
      return;
    }
    // 提取时锁定「当前章节 + 当前激活版本」，用于后续判断正文是否被切换过
    const chapterNo = activeChapter.chapter_no;
    const versionId = activeVersion?.id ?? null;
    setExtracting(true);
    setExtractResult(null);
    let out = "";
    try {
      ensureReady();
      await runAgent(
        "extractor",
        novelId,
        { chapter_no: activeChapter.chapter_no, chapter_text: activeChapter.active_content },
        (ev) => {
          if (ev.event === "stored") {
            out = JSON.stringify(ev.data, null, 2);
            setExtractResult(out);
            setExtractedChapterNo(chapterNo);
            setExtractedVersionId(versionId);
            // 本次重提取是否清掉了「被取代过的链条中间环」：若是，列出受影响的下游章节，
            // 提示作者重新提取对齐（根部删/改后，下游递进前提已断裂）。
            const d = ev.data as { downstream_affected?: AffectedChapter[] };
            const affected = Array.isArray(d?.downstream_affected)
              ? d.downstream_affected.filter((a) => a.chapter_no > 0)
              : [];
            setAffectedChapters(affected.length > 0 ? affected : null);
            showToast(`第 ${activeChapter.chapter_no} 章已提取入记忆层`, "success");
            // 刷新目录，让列表里的提取版本记录（extracted_version_id）立即更新，刷新页面也不会误报高亮
            void loadChapters();
          } else if (ev.event === "stream_error") {
            showToast((ev.data as { message?: string }).message ?? "AI 提取出错，请稍后重试。", "error");
          }
        },
      );
      if (!out) showToast("提取完成（未返回 stored 事件）", "warning");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setExtracting(false);
    }
  }

  async function handleReview() {
    if (!activeChapter) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!activeChapter.active_content) {
      showToast("该章尚未选定版本，无法评价。请先完成生成与选定。", "warning");
      return;
    }
    setReviewing(true);
    setReviews(null);
    setReviewRun({ thinking: "", output: "", running: true });
    try {
      ensureReady();
      await runAgent(
        "critic",
        novelId,
        {
          chapter_no: activeChapter.chapter_no,
          chapter_text: activeChapter.active_content,
          writing_mode: "draft_free",
          outline: approvedOutline ? summarizeOutline(approvedOutline) : undefined,
        },
        (ev) => {
          const d = ev.data as { delta?: string; status?: string; message?: string };
          if (ev.event === "thinking_delta" && d.delta) {
            setReviewRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
          } else if (ev.event === "stream_delta" && d.delta) {
            setReviewRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
          } else if (ev.event === "schema_validate" && d.status !== "ok") {
            showToast("评价 schema 校验失败，可重试。", "error");
          } else if (ev.event === "stored") {
            showToast(`第 ${activeChapter.chapter_no} 章评价已落库 quality_reviews（对照蓝图/伏笔账本）。`, "success");
            void listReviews(novelId, activeChapter.chapter_no)
              .then(setReviews)
              .catch(() => undefined);
          } else if (ev.event === "stream_error") {
            showToast((ev.data as { message?: string }).message ?? "AI 评价出错，请稍后重试。", "error");
          }
        },
      );
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setReviewing(false);
      setReviewRun((r) => (r ? { ...r, running: false } : r));
    }
  }

  /** 根部关系被删/改后，按序串行处理受影响的下游章节：
   *   第 A 章重写正文（按该章已批大纲，无大纲则自由草稿）→ 第 A 章「提取→记忆层」→ 第 B 章重写 → 第 B 章提取 …
   *  重写用的是 novelist（按大纲写新正文、追加为版本并自动定稿），不按评价来。
   *  任一章失败即停止整个流程，弹右上角 error 通知分章列出未完成的正文/提取，交作者手动补齐（15s 自动关闭）。
   *  进度查看与手动生成完全一致：Message 提示 + 「查看 AI 过程」弹窗 + 目录/详情刷新。 */
  async function handleRerunAffected() {
    if (!affectedChapters || affectedChapters.length === 0) return;
    const target = affectedChapters.map((a) => a.chapter_no); // 按受影响章节逐个处理
    setAffectedChapters(null); // 按钮点击后通知立即关闭
    setRewriteFail(null);
    try {
      ensureReady();
      let failedChapter: number | null = null;
      const doneRewrite: number[] = [];
      const doneExtract: number[] = [];
      for (const no of target) {
        const o = approvedOutlines.find((x) => x.chapter_no === no) ?? null;
        const ch = chapters.find((c) => c.chapter_no === no) ?? null;
        // ── 1. 重写正文（按当前大纲，不按评价）──
        // 与真人点「生成正文」一致：只更新后台状态，弹窗由作者手动点「查看 AI 过程」查看
        setGenRun({ thinking: "", output: "", running: true });
        try {
          await runAgent(
            "novelist",
            novelId,
            {
              chapter_no: no,
              title: o?.title ?? ch?.title ?? undefined,
              outline: o ? summarizeOutline(o) : undefined,
              writing_mode: o ? "outline_guided" : "draft_free",
            },
            (ev) => {
              const d = ev.data as { delta?: string; status?: string; message?: string };
              if (ev.event === "thinking_delta" && d.delta) {
                setGenRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
              } else if (ev.event === "stream_delta" && d.delta) {
                setGenRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
              } else if (ev.event === "stream_error") {
                failedChapter = no;
                showToast((ev.data as { message?: string }).message ?? `第 ${no} 章重写出错`, "error");
              }
            },
          );
        } catch (e) {
          failedChapter = no;
          showToast((e as Error).message, "error");
        } finally {
          setGenRun((r) => (r ? { ...r, running: false } : r));
        }
        if (failedChapter != null) break;
        doneRewrite.push(no);
        showToast(`第 ${no} 章已按大纲重写完成`, "success");

        // ── 2. 提取记忆层（用重写后的新正文）──
        let fresh: ChapterListItem[] = [];
        try {
          fresh = await listChapters(novelId); // 目录刷新后才能拿到该章新定稿正文
          setChapters(fresh);
        } catch {
          fresh = chapters;
        }
        const freshCh = fresh.find((c) => c.chapter_no === no) ?? null;
        try {
          await runAgent(
            "extractor",
            novelId,
            { chapter_no: no, chapter_text: freshCh?.active_content ?? ch?.active_content },
            (ev) => {
              if (ev.event === "stream_error") {
                failedChapter = no;
                showToast((ev.data as { message?: string }).message ?? `第 ${no} 章提取出错`, "error");
              }
            },
          );
        } catch (e) {
          failedChapter = no;
          showToast((e as Error).message, "error");
        }
        if (failedChapter != null) break;
        doneExtract.push(no);
        showToast(`第 ${no} 章已提取入记忆层`, "success");
        void loadChapters();
        if (activeNo === no) void loadDetail(no);
      }

      await loadChapters();
      if (failedChapter != null) {
        // 失败即停止：分章列出「正文未重写 / 记忆层未提取」，交作者手动补齐（含失败后还没轮到处理的章节）
        const remainingRewrite = target.filter((n) => !doneRewrite.includes(n));
        const remainingExtract = target.filter((n) => !doneExtract.includes(n));
        setRewriteFail({ failedChapter, remainingRewrite, remainingExtract });
        const tip = [];
        if (remainingRewrite.length > 0) tip.push(`正文未重写：第 ${remainingRewrite.join("、")} 章`);
        if (remainingExtract.length > 0) tip.push(`记忆层未提取：第 ${remainingExtract.join("、")} 章`);
        showToast(
          `第 ${failedChapter} 章处理失败，联动已停止。${tip.length > 0 ? `剩余 ${tip.join("；")}，请手动补齐。` : ""}`,
          "error",
        );
      } else {
        showToast("受影响章节已全部重写并重新提取，关系链已对齐", "success");
      }
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  }

  /** 按评价报告逐条优化本章正文（修订师），修订版直接定稿为新版本。 */
  async function handleRevise(review: QualityReview) {
    if (!activeChapter) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!activeChapter.active_content) {
      showToast("该章尚未选定版本，无法优化。请先完成生成与选定。", "warning");
      return;
    }
    if (!review.is_current) {
      showToast(
        `这条评价针对 v${review.version_no ?? "?"}，已不是当前正文。请先还原到该版本，或对当前正文重新评价。`,
        "warning",
      );
      return;
    }
    setRevising(true);
    setSettingGaps(null);
    setReviseRun({ thinking: "", output: "", running: true });
    try {
      ensureReady();
      await runAgent(
        "reviser",
        novelId,
        {
          chapter_no: activeChapter.chapter_no,
          chapter_text: activeChapter.active_content,
          writing_mode: form.writing_mode,
          outline: approvedOutline ? summarizeOutline(approvedOutline) : undefined,
          chapter_function: form.chapter_function,
          review: {
            overall_score: review.overall_score,
            rubric: review.rubric,
            issues: review.issues,
            strengths: review.strengths,
            revision_hints: review.revision_hints,
          },
        },
        (ev) => {
          const d = ev.data as { delta?: string; message?: string };
          if (ev.event === "thinking_delta" && d.delta) {
            setReviseRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
          } else if (ev.event === "stream_delta" && d.delta) {
            setReviseRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
          } else if (ev.event === "setting_warning") {
            const items = (ev.data as { items?: SettingGap[] }).items ?? [];
            setSettingGaps(items.length ? items : null);
          } else if (ev.event === "stored") {
            showToast(
              `已按评价问题优化第 ${activeChapter.chapter_no} 章并定稿为新版本。不满意可点下方版本列表里的旧版本一键还原（可重新评价）。`,
              "success",
            );
          } else if (ev.event === "stream_error") {
            showToast((ev.data as { message?: string }).message ?? "AI 优化出错，请稍后重试。", "error");
          }
        },
      );
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setRevising(false);
      setReviseRun((r) => (r ? { ...r, running: false } : r));
      setActiveNo(activeChapter.chapter_no);
      await loadChapters();
      await loadDetail(activeChapter.chapter_no);
    }
  }

  return (
    <Loading loading={loading}>
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)] xl:gap-8">
      {/* 左侧：章节目录（一件事一张卡，按卷分组、可展开搜索，与大纲页一致）。
          模块高度跟随内容，最多与页面底部对齐；内容多时在列表内滚动，避免整页滚动条。 */}
      <aside className="flex max-h-[calc(100dvh-6rem)] min-w-0 flex-col gap-4 overflow-hidden">
        <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="panel-head shrink-0">
            <h3 className="panel-title">章节目录</h3>
            <div className="flex items-center gap-2">
              <span className="panel-hint">{chapters.length} 章</span>
              <button
                type="button"
                onClick={openAddModal}
                className="btn btn-primary px-2.5 py-1 text-xs font-medium"
              >
                新增章节
              </button>
            </div>
          </div>
          {chapters.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有章节。点右上角「新增章节」，写下一章。
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <input
                className="mb-3 w-full shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                placeholder="搜索章节（章号 / 标题）"
                value={chapterSearch}
                onChange={(e) => setChapterSearch(e.target.value)}
              />
              <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                {volGroups
                  .map((g) => {
                    const items = chapterQ ? g.items.filter(chapterMatches) : g.items;
                    return items.length > 0 ? { g, items } : null;
                  })
                  .filter((x): x is { g: ChapterVolumeGroup; items: ChapterListItem[] } => x != null)
                  .map(({ g, items }, idx, arr) => {
                    const isCollapsed = !chapterQ && collapsedVols[g.key];
                    const isLast = idx === arr.length - 1;
                    return (
                      <section key={g.key} className={isLast ? "" : "mb-2"}>
                        <button
                          type="button"
                          onClick={() =>
                            !chapterQ &&
                            setCollapsedVols((prev) => ({ ...prev, [g.key]: !prev[g.key] }))
                          }
                          className={`mb-1.5 flex w-full items-start gap-1.5 text-left ${
                            chapterQ ? "cursor-default" : "cursor-pointer"
                          }`}
                        >
                          <span
                            className={`mt-0.5 shrink-0 text-[10px] text-zinc-400 transition-transform ${
                              isCollapsed ? "-rotate-90" : ""
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
                        {!isCollapsed && (
                          <ul className="flex flex-col gap-2">
                            {items.map((c) => (
                              <li key={c.id}>
                                <button
                                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                                    activeNo === c.chapter_no
                                      ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
                                      : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                                  }`}
                                  onClick={() => {
                                    if (activeNo === c.chapter_no) {
                                      setActiveNo(null);
                                      setDetail(null);
                                      setExtractResult(null);
                                      setReviews(null);
                                      return;
                                    }
                                    setActiveNo(c.chapter_no);
                                    setExtractResult(null);
                                    setReviews(null);
                                    void loadDetail(c.chapter_no);
                                  }}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium">
                                      第{c.chapter_no}章{c.title ? ` ${c.title}` : ""}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-zinc-500">
                                    {c.status === "complete" ? (
                                      <span className="rounded bg-green-100 px-1 py-0.5 text-green-700 dark:bg-green-900 dark:text-green-300">
                                        已定稿
                                      </span>
                                    ) : (
                                      <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">草稿</span>
                                    )}
                                    {c.active_source && <span>{sourceLabel(c.active_source)}</span>}
                                    {c.word_count != null && <span>{c.word_count}字</span>}
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
            </div>
          )}
        </div>

        {/* 本章操作：评价 / 入记忆 / 复制正文，收在一张卡里。必须选中章节才能点（针对某一章）。
            shrink-0：高度固定，始终把目录面板挤到剩余的视口高度里去滚动。 */}
        <div className="panel shrink-0">
          <div className="panel-head">
            <h3 className="panel-title">本章操作</h3>
            {activeNo != null && (
              <span className="panel-hint">
                第 {activeNo} 章{activeChapter?.title ? ` ${activeChapter.title}` : ""}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <button
              className={`w-full cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors ${
                reviewPending
                  ? "border-amber-500 bg-gradient-to-r from-amber-200 to-amber-50 font-medium text-amber-800 hover:border-amber-600 hover:from-amber-300 hover:to-amber-100 dark:border-amber-500 dark:from-amber-800/80 dark:to-amber-950/60 dark:text-amber-300 dark:hover:border-amber-400 dark:hover:from-amber-800 dark:hover:to-amber-900/70 disabled:hover:border-amber-500 dark:disabled:hover:border-amber-500"
                  : "border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 disabled:hover:border-zinc-300 dark:disabled:hover:border-zinc-700"
              } disabled:cursor-not-allowed disabled:opacity-100`}
              onClick={handleReview}
              disabled={activeNo == null || reviewing || !activeChapter?.active_content}
              title={
                activeNo == null
                  ? "请先在章节目录选择一章"
                  : !activeChapter?.active_content
                    ? "先选定版本再评价"
                    : currentReview
                      ? "对照蓝图/伏笔账本评价本章"
                      : "当前定稿正文还没有评价，建议先评价本章"
              }
            >
              {reviewing ? "评价中…" : "评价本章"}
            </button>
            {/* 三个操作按钮等宽：问号收进按钮内右侧，不再占按钮外的横向空间 */}
            <button
              className={`relative w-full cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors ${
                extractPending
                  ? "border-blue-500 bg-gradient-to-r from-blue-200 to-blue-50 font-medium text-blue-800 hover:border-blue-600 hover:from-blue-300 hover:to-blue-100 dark:border-blue-500 dark:from-blue-800/80 dark:to-blue-950/60 dark:text-blue-300 dark:hover:border-blue-400 dark:hover:from-blue-800 dark:hover:to-blue-900/70 disabled:hover:border-blue-500 dark:disabled:hover:border-blue-500"
                  : "border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 disabled:hover:border-zinc-300 dark:disabled:hover:border-zinc-700"
              } disabled:cursor-not-allowed disabled:opacity-100`}
              onClick={handleExtract}
              disabled={activeNo == null || extracting}
              title={
                activeNo == null
                  ? "请先在章节目录选择一章"
                  : !activeChapter?.active_content
                    ? "先选定版本再提取"
                    : extractPending
                      ? "当前定稿正文还没提取过记忆层（或已切到新版本），建议先提取"
                      : "把本章摘要/角色状态/伏笔写进记忆层"
              }
            >
              {extracting ? "提取中…" : "提取 → 记忆层"}
              <span
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={(e) => e.stopPropagation()}
              >
                <InfoTip side="right">
                  <p className="font-medium text-zinc-700 dark:text-zinc-200">提取本章 = 给 AI 记账。</p>
                  把这一章的摘要、角色当前状态、新埋的伏笔等写进「记忆层」。
                  下一章生成时小说家会自动读到，角色性格的变化也靠它跟踪。
                  <span className="mt-1.5 block text-zinc-400">
                    每写完一章记得点一下，不然下一章可能"忘了"刚才发生了什么。
                  </span>
                </InfoTip>
              </span>
            </button>
            <button
              type="button"
              onClick={handleCopyContent}
              disabled={activeNo == null || !activeChapter?.active_content}
              className="w-full cursor-pointer rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-600 hover:border-zinc-500 disabled:cursor-not-allowed disabled:hover:border-zinc-300 disabled:opacity-100 dark:border-zinc-700 dark:text-zinc-300 dark:disabled:hover:border-zinc-700"
            >
              {copied ? "已复制 ✓" : "复制本章正文"}
            </button>
            <div className="mt-1 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
              <CostHint />
            </div>
          </div>
        </div>
      </aside>

      {/* 右侧：本章正文 + 评价与优化入口（一步一张卡） */}
      <section className={`flex min-w-0 flex-col gap-5 sm:gap-7 ${hasContent ? "h-[calc(100dvh-6rem)]" : ""}`}>
        {/* ① 当前章节正文（全部版本 + 已定稿正文），显示在界面、不撑破页面高度 */}
        {detail ? (
          <div className="panel flex min-h-0 flex-1 flex-col">
            <div className="panel-head">
              <h3 className="panel-title">
                第 {detail.chapter_no} 章
                {detail.title ? ` ${detail.title}` : ""}
                <span className="ml-1 text-xs font-normal text-zinc-500">
                  {detail.status === "complete" ? "已定稿" : "草稿"}
                </span>
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openRegenerateModal}
                  disabled={activeNo == null || generating}
                  className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                  title="复用新增章节弹窗，基于当前章节重新生成一版正文（新增为一个版本）"
                >
                  重新生成正文
                </button>
                <button
                  type="button"
                  onClick={() => setShowReviewModal(true)}
                  disabled={activeNo == null}
                  className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                  title={activeNo == null ? "请先选择一章" : "打开评价与优化"}
                >
                  评价与优化
                </button>
              </div>
            </div>
            <div className="mb-3 flex shrink-0 flex-wrap gap-1.5">
              {detail.versions.map((v) => (
                <button
                  key={v.id}
                  title={v.is_active ? "当前版本（已定稿）" : "点击还原到此版本"}
                  disabled={v.is_active}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-100 ${
                    v.is_active
                      ? "border-green-500 bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-300"
                      : "border-zinc-300 hover:border-zinc-500 dark:border-zinc-700"
                  }`}
                  onClick={() => handleSelectVersion(v.id)}
                >
                  {sourceLabel(v.source)} · v{v.version_no}
                  {v.is_active ? " ✓" : ""}
                </button>
              ))}
            </div>
            {/* 写后设定自检：本轮 AI 输出疑似漏写了某组成组内容时给出明确告警 */}
            {settingGaps && settingGaps.length > 0 && (
              <div className="mb-3 shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-6 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="font-medium">
                  设定自检：本轮正文疑似漏写了 {settingGaps.length} 处成组内容
                </p>
                <ul className="mt-1 space-y-0.5">
                  {settingGaps.map((g) => (
                    <li key={`${g.rule}-${g.missing.join("-")}`}>
                      《{g.rule}》要求 [{g.group.join(" + ")}] 同时出现，已写到{" "}
                      {g.present.join("、")}，<span className="font-medium">缺失 {g.missing.join("、")}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-amber-700/80 dark:text-amber-300/70">
                  属机器字面核对的提醒：若本章确实不该写到该项，可忽略；否则建议重新生成，或在这一茬上手动补写。
                </p>
              </div>
            )}
            {activeChapter?.active_content ? (
              <div className="reading flex-1 min-h-0 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-5 whitespace-pre-wrap dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
                {activeChapter.active_content}
              </div>
            ) : (
              <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
                本章还没有定稿正文。
              </p>
            )}
          </div>
        ) : activeNo != null ? (
          <div className="panel flex min-h-0 flex-1 flex-col">
            <div className="panel-head">
              <h3 className="panel-title">
                第 {activeNo} 章
              </h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
              第 {activeNo} 章正文尚未生成或加载失败。
            </p>
          </div>
        ) : (
          <div className="panel flex min-h-0 flex-1 flex-col">
            <div className="panel-head">
              <h3 className="panel-title">
                本章正文
              </h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              在左侧章节目录选一章查看正文，或点「新增章节」写新的一章。
            </p>
          </div>
        )}

        {/* 记忆层入账回执 */}
        {extractResult && (
          <div className="panel">
            <div className="panel-head">
              <h3 className="panel-title">
                <span className="panel-step">3</span>
                记忆层入账回执
              </h3>
              <span className="panel-hint">story_state 已写入，下一章小说家会读到</span>
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg border border-green-200 bg-green-50 p-3 text-xs dark:border-green-900 dark:bg-green-950">
              {extractResult}
            </pre>
          </div>
        )}

        {/* 联动重写中断：已迁移为右上角全局 error Notification（writing-panel 顶部 rewriteFail 同步 effect 管理） */}
      </section>

      {/* ── 新增章节弹窗 ── */}
      <Modal
        open={showAddModal}
        title={regenerateNo != null ? "重新生成章节正文" : "新增章节"}
        subtitle={
          regenerateNo != null
            ? `将基于当前章节设置重新生成第 ${form.chapter_no} 章正文（新增为一个版本），标题 / 大纲目标 / 章节功能等均可修改。`
            : `将追加为第 ${nextNo} 章（目录最新一章的下一章），生成后自动定稿。`
        }
        onClose={() => {
          setShowAddModal(false);
          setRegenerateNo(null);
        }}
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
                disabled={generating || !canAdd}
                className="btn btn-primary px-4 py-1.5 disabled:opacity-50"
              >
                {generating ? "生成中…" : "生成正文"}
              </button>
              {genRun && (
                <button
                  type="button"
                  onClick={() => setShowGenRun(true)}
                  className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                >
                  {genRun.running ? "查看 AI 过程…" : "查看 AI 过程"}
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-xs text-zinc-500">
              写作模式
              <InfoTip portal>
                <p className="font-medium text-zinc-700 dark:text-zinc-200">决定本章是否严格按大纲走</p>
                · 大纲约束：按已批大纲写，系统自动取「第 {nextNo} 章」的已批大纲回填
                <br />· 自由草稿：不按大纲，章节名自己填，标题由 AI 根据内容生成
              </InfoTip>
            </span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.writing_mode}
              onChange={(e) => changeWritingMode(e.target.value)}
            >
              <option value="outline_guided">大纲约束（按大纲）</option>
              <option value="draft_free">自由草稿（不按大纲）</option>
            </select>
          </label>

          {/* 大纲约束：自动取该章已批大纲；无则提示去大纲页 */}
          {form.writing_mode === "outline_guided" &&
            (targetOutline ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-xs text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                将基于已批大纲：第 {targetOutline.chapter_no} 章
                {targetOutline.title ? `《${targetOutline.title}》` : ""}（大纲内容已自动填入下方「本章大纲目标」）。
              </div>
            ) : (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-6 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                第 {nextNo} 章还没有已批大纲，无法按大纲生成。
                <br />
                请先到「大纲」页让大纲师排第 {nextNo} 章并「批准生效」，再回来新增。
              </div>
            ))}

          {/* 自由草稿：章节名称（带标签，避免高度错位） */}
          {form.writing_mode === "draft_free" && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">章节名称</span>
              <input
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                placeholder="章节标题（留空则 AI 自动生成）"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">章节功能</span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.chapter_function}
              onChange={(e) => setForm({ ...form, chapter_function: e.target.value })}
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
            <span className="text-xs text-zinc-500">本章大纲目标</span>
            <AutoTextarea
              value={form.outline}
              onChange={(v) => setForm({ ...form, outline: v })}
              maxHeight={200}
              placeholder={
                form.writing_mode === "outline_guided"
                  ? "已自动来自该章已批大纲，可微调后交给小说家"
                  : "本章大纲/目标（可选，填了会交给小说家；不填则自由发挥）"
              }
              className="resize-none rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>

          {/* 信息控制：高级可选项，点开独立弹窗填写/清空 */}
          <div className="flex items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <span className="text-xs text-zinc-500">
              信息控制（高级，可选）
              <InfoTip portal>
                <p className="font-medium text-zinc-700 dark:text-zinc-200">控制「谁知道了什么」</p>
                防止 AI 提前剧透或逻辑穿帮；全部留空则交给小说家自行把握。
                <span className="mt-1.5 block text-zinc-400">
                  读者已知 / 主角已知 / 必须向读者隐瞒 / 只能点到为止（伏笔暗示）
                </span>
              </InfoTip>
            </span>
            <button
              type="button"
              onClick={openInfoModal}
              className="btn btn-ghost px-2.5 py-1 text-xs font-medium"
            >
              {infoFilledCount > 0 ? `已填 ${infoFilledCount} 项 · 编辑` : "填写"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── 信息控制弹窗（本地 draft：取消丢弃 / 清空只清本地 / 完成才提交） ── */}
      <Modal
        open={showInfoModal}
        title="信息控制（高级，可选）"
        subtitle="控制本章「谁知道了什么」，防止 AI 提前剧透或逻辑穿帮。"
        onClose={() => setShowInfoModal(false)}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowInfoModal(false)}
              className="btn btn-ghost px-4 py-1.5"
            >
              取消
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setInfoDraft({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" })
                }
                className="btn btn-ghost px-4 py-1.5"
              >
                清空
              </button>
              <button
                type="button"
                onClick={() => {
                  setForm((f) => ({ ...f, ...infoDraft }));
                  setShowInfoModal(false);
                }}
                className="btn btn-primary px-4 py-1.5"
              >
                完成
              </button>
            </div>
          </div>
        }
      >
        <div className="grid gap-3">
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="读者已知：…"
            value={infoDraft.reader_knows}
            onChange={(e) => setInfoDraft({ ...infoDraft, reader_knows: e.target.value })}
          />
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="主角已知：…"
            value={infoDraft.protagonist_knows}
            onChange={(e) => setInfoDraft({ ...infoDraft, protagonist_knows: e.target.value })}
          />
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="必须向读者隐瞒：…"
            value={infoDraft.must_hide}
            onChange={(e) => setInfoDraft({ ...infoDraft, must_hide: e.target.value })}
          />
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="只能点到为止（伏笔暗示）：…"
            value={infoDraft.hint_only}
            onChange={(e) => setInfoDraft({ ...infoDraft, hint_only: e.target.value })}
          />
          <p className="text-xs leading-relaxed text-zinc-500">
            全部留空则交给小说家自行把握。点「完成」才保存；点「清空」只清当前输入、不立即生效；点「取消」则放弃本次改动。
          </p>
        </div>
      </Modal>

      {/* ── 评价与优化弹窗 ── */}
      <Modal
        open={showReviewModal}
        title="评价与优化"
        maxWidth="max-w-2xl"
        subtitle={
          detail
            ? `第 ${detail.chapter_no} 章${detail.title ? ` ${detail.title}` : ""} · 当前正文：v${activeVersion?.version_no ?? "?"}${activeVersion ? ` ${sourceLabel(activeVersion.source)}` : ""}`
            : undefined
        }
        onClose={() => setShowReviewModal(false)}
      >
        {detail ? (
          currentReview ? (
            <ReviewCard
              review={currentReview}
              onRevise={handleRevise}
              revising={revising}
              viewButton={
                reviseRun ? (
                  <button
                    type="button"
                    onClick={() => setShowReviseRun(true)}
                    className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                  >
                    {reviseRun.running ? "查看 AI 过程…" : "查看 AI 过程"}
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-300 p-5 text-center dark:border-zinc-700">
              <p className="text-xs leading-6 text-zinc-500 dark:text-zinc-400">
                {activeChapter?.active_content ? (
                  <>
                    当前正文（v{activeVersion?.version_no ?? "?"}
                    {activeVersion ? ` ${sourceLabel(activeVersion.source)}` : ""}）还没有评价。
                    点下方「评价本章」，评价师会对照蓝图、伏笔账本与设定逐项打分。
                  </>
                ) : (
                  "该章还没有选定版本的正文，先在界面生成并选定一版，再回来评价。"
                )}
              </p>
              <div className="mt-2.5 flex items-center justify-center gap-2">
                <button
                  onClick={handleReview}
                  disabled={reviewing || !activeChapter?.active_content}
                  className="btn btn-primary px-3 py-1.5 text-xs font-medium"
                >
                  {reviewing ? "评价中…" : "评价本章"}
                </button>
                {reviewRun && (
                  <button
                    type="button"
                    onClick={() => setShowReviewRun(true)}
                    className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                  >
                    {reviewRun.running ? "查看 AI 过程…" : "查看 AI 过程"}
                  </button>
                )}
              </div>
            </div>
          )
        ) : (
          <p className="text-center text-xs text-zinc-400">请先在左侧章节目录选择一章。</p>
        )}
      </Modal>

      {/* ── AI 处理过程弹窗（通用组件）：生成正文 / 评价 / 优化共用 ── */}
      <AiRunDialog
        open={showGenRun}
        title={`小说家 · 第 ${form.chapter_no} 章 · ${regenerateNo != null ? "重新生成正文" : "新增正文"}`}
        subtitle="AI 正在生成正文，思考过程与输出文字实时滚动显示；关闭弹窗不会中断任务。"
        thinking={genRun?.thinking ?? ""}
        output={genRun?.output ?? ""}
        running={genRun?.running ?? false}
        onClose={() => setShowGenRun(false)}
      />
      <AiRunDialog
        open={showReviewRun}
        title={`评价师 · 评价第 ${activeNo ?? "?"} 章`}
        subtitle="评价师正在对照蓝图、伏笔账本与设定逐项打分；思考过程与输出文字实时滚动显示。"
        thinking={reviewRun?.thinking ?? ""}
        output={reviewRun?.output ?? ""}
        running={reviewRun?.running ?? false}
        onClose={() => setShowReviewRun(false)}
      />
      <AiRunDialog
        open={showReviseRun}
        title={`修订师 · 优化第 ${activeNo ?? "?"} 章`}
        subtitle="修订师正在逐条对照评价问题优化正文；思考过程与输出文字实时滚动显示。"
        thinking={reviseRun?.thinking ?? ""}
        output={reviseRun?.output ?? ""}
        running={reviseRun?.running ?? false}
        onClose={() => setShowReviseRun(false)}
      />
      </div>
    </Loading>
  );
}

/** 评价师结果卡片：整体分 + 六维评分 + 问题 + 亮点 + 修改建议 + 按评价优化。 */
function ReviewCard({
  review,
  onRevise,
  revising,
  viewButton,
}: {
  review: QualityReview;
  onRevise: (r: QualityReview) => void;
  revising: boolean;
  /** 出现在「按评价优化本章」左侧的附加按钮（如：查看 AI 过程）。 */
  viewButton?: ReactNode;
}) {
  const rubric = review.rubric ?? {};
  const rubricEntries = Object.entries(rubric);
  const scoreColor = (s?: number) =>
    s == null ? "" : s >= 80 ? "text-green-600" : s >= 60 ? "text-amber-600" : "text-red-600";
  return (
    <div className="rounded-lg bg-sunken/40 p-4">
      <div className="mb-3 flex items-center gap-3">
        <span className={`text-4xl font-bold ${scoreColor(review.overall_score ?? undefined)}`}>
          {review.overall_score ?? "—"}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold">评价师 · 第 {review.chapter_no ?? "?"} 章评审</h3>
            {review.version_no != null && (
              <span
                title={
                  review.is_current
                    ? `针对当前正文 v${review.version_no}`
                    : "针对已被取代的旧版本"
                }
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  review.is_current
                    ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                    : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                }`}
              >
                v{review.version_no}
                {review.version_source ? ` ${sourceLabel(review.version_source)}` : ""}
                {review.is_current ? "" : " · 旧版本"}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500">
            {review.created_at ? new Date(review.created_at).toLocaleString() : ""}
            {review.chapter_title ? ` · ${review.chapter_title}` : ""}
          </p>
        </div>
      </div>

      {rubricEntries.length > 0 && (
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          {rubricEntries.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{k}</span>
                <span className={`text-sm font-bold ${scoreColor(v?.score)}`}>{v?.score ?? "—"}</span>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-300">{v?.comment}</p>
              {v?.evidence && (
                <p className="mt-1 border-l-2 border-zinc-200 pl-2 text-[11px] text-zinc-400 dark:border-zinc-700">
                  {v.evidence}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {review.issues && review.issues.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">问题</h4>
          <ul className="flex flex-col gap-1.5">
            {review.issues.map((i, idx) => (
              <li key={idx} className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs dark:border-red-900 dark:bg-red-950">
                <span className="mr-1.5 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-700 dark:bg-red-900 dark:text-red-300">
                  {i.severity ?? "?"}
                </span>
                {i.desc}
                {i.suggested_fix && (
                  <span className="mt-1 block text-red-700/80 dark:text-red-300/80">改法：{i.suggested_fix}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {review.strengths && review.strengths.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-green-600 dark:text-green-400">亮点</h4>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-zinc-600 dark:text-zinc-300">
              {review.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {review.revision_hints && review.revision_hints.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">修改建议</h4>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-zinc-600 dark:text-zinc-300">
              {review.revision_hints.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {review.is_current ? (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p className="text-[11px] text-zinc-400">修订师会逐条对照以上问题优化当前正文（v{review.version_no}），保留原情节走向，修订版存为新版本。</p>
          <div className="flex shrink-0 items-center gap-2">
            {viewButton}
            <button
              onClick={() => onRevise(review)}
              disabled={revising}
              className="btn btn-primary shrink-0 px-3 py-1.5 text-xs font-medium"
            >
              {revising ? "AI 优化中…" : "按评价优化本章"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p className="text-[11px] text-zinc-400">
            这条评价针对 v{review.version_no}
            {review.version_source ? `（${sourceLabel(review.version_source)}）` : ""}，
            当前正文已是更新的版本，评价不再对得上。要点上方版本列表的「v{review.version_no}」
            还原后再优化，或直接对当前正文重新评价。
          </p>
        </div>
      )}
    </div>
  );
}
