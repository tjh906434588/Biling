/**
 * @file writing/notifications.tsx
 * 写作页「全局右上角通知」的模块级状态、渲染与同步逻辑（跨写作页卸载/切页存活）：
 * - affected*（后续章节关系受影响）：常驻、无自动关闭，只有点 ✕ 或「挨个重写」才关闭；
 * - rewrite*（联动重写中断）：error 类型、不可手动关闭，只累计页面可见时间满 15s 自动关闭，
 *   刷新从 localStorage 恢复数据与剩余时长；
 * - gaps*（写后设定自检）：带「重新生成/忽略」操作，切换章节/换小说即自动移除。
 * 这些模块状态是全局单例、必须整体留在本文件：WritingPanel 卸载时通知不清除、数据保留，
 * 由 workspace 页面 showWorkspaceNotifs/hideWorkspaceNotifs 与 WritingPanel 初始状态还原。
 */
"use client";

import { useEffect } from "react";
import { closeNotification, notification, removeNotification } from "@/components/notification";
import { REWRITE_FAIL_TOTAL_MS } from "@/constants";
import type { SettingGap } from "@/lib/api";
import { rewriteFailDataKey, rewriteFailRemainingKey } from "@/utils/storage";

/** 下游受影响章节（递进链被根部改动波及）：每项带关系信息，前端据此展示「是什么影响到了这章」。
 *  origin_chapter / origin_relation 是被删/改的根因（如第1章 师徒），relation 是该章受影响的关系。 */
export interface AffectedChapter {
  chapter_no: number;
  source: string;
  target: string;
  relation: string;
  origin_chapter: number;
  origin_relation: string;
}

/** 联动重写中断 → 全局 Notification 的模块级状态（跨写作页卸载/切页存活）：
 *  error 类型、无 ✕（closable:false），只能自动关闭；
 *  总展示 15s，但只累计「页面可见时间」：离开页面暂停并保留剩余时长，回来继续累计，
 *  刷新从 localStorage 恢复数据与剩余，直到累计满 15s 才自动关闭（通知继续显示、不清除）。 */
export interface RewriteFailData {
  failedChapter: number;
  remainingRewrite: number[];
  remainingExtract: number[];
}

/** 受影响章节 → 全局 Notification 的模块级状态（跨写作页卸载/切页存活）：
 *  通知悬浮在右上角、常驻，切页不隐藏；只有点 ✕ 或「挨个重写」才关闭（与新手引导不同，不随页面隐藏）。
 *  组件卸载时不清理通知，数据存在这里，切页回来由组件初始状态还原。 */
let affectedNotifId: number | null = null;
let affectedData: AffectedChapter[] | null = null;
let affectedNovelId: string | null = null;
let affectedRerun: (() => void) | null = null;
let affectedClear: (() => void) | null = null;

let rewriteNotifId: number | null = null;
let rewriteFailData: RewriteFailData | null = null;
let rewriteNovelId: string | null = null;
let rewriteRemainingMs = 0;

/** 写后设定自检（setting_warning）→ 右上角告警通知的模块级状态：带「重新生成/忽略」操作。
 *  切换章节或离开工作台即自动移除，避免挂着一个旧章节的告警（此时点「重新生成」目标会错）。 */
let gapsNotifId: number | null = null;
let gapsNotifChapter: number | null = null;
let gapsNotifNovel: string | null = null;

/** 刷新后恢复中断数据（模块变量已重置，只能从 localStorage 读）。 */
export function loadRewriteFailData(novelId: string): RewriteFailData | null {
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
export function saveRewriteFailData(novelId: string, data: RewriteFailData | null) {
  try {
    if (data) localStorage.setItem(rewriteFailDataKey(novelId), JSON.stringify(data));
    else localStorage.removeItem(rewriteFailDataKey(novelId));
  } catch {
    /* 忽略 */
  }
}
/** 刷新后恢复剩余展示时长（页面可见时才递减）。 */
export function loadRewriteRemaining(novelId: string): number {
  try {
    const v = Number(localStorage.getItem(rewriteFailRemainingKey(novelId)));
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    /* 忽略 */
  }
  return 0;
}
export function saveRewriteRemaining(novelId: string, ms: number) {
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
    title: "自动连续重写中断",
    message: (
      <div className="space-y-2">
        {/* 根因 */}
        <div className="rounded-md bg-red-100/80 px-2.5 py-1.5 dark:bg-red-900/50">
          <p className="text-[12px] font-semibold leading-5 text-red-900 dark:text-red-100">根因</p>
          <p className="mt-0.5 text-[12px] leading-5 text-red-800/90 dark:text-red-200/90">
            第 <span className="font-medium">{data.failedChapter}</span> 章处理失败，自动连续处理已停止；
            失败之后还没轮到处理的章节同样未完成，剩下的章节请手动逐个处理。
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
  if (gapsNotifId != null && gapsNotifNovel === novelId) {
    removeNotification(gapsNotifId);
    gapsNotifId = null;
    gapsNotifChapter = null;
    gapsNotifNovel = null;
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
export function syncAffectedNotif(
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
            被删除/替换，以下章节的正文还建立在之前的剧情线上，需要按当前大纲重写，并重新记进记忆。
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
          挨个重写这几章，并重新记进记忆
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

/** WritingPanel 初始状态的模块级还原：本小说挂着的受影响章节数据（切页回来用）。 */
export function getInitialAffectedChapters(novelId: string): AffectedChapter[] | null {
  return affectedNovelId === novelId && affectedData ? affectedData : null;
}

/** WritingPanel 初始状态的模块级还原：本小说挂着的中断数据，刷新则从 localStorage 兜底恢复。 */
export function getInitialRewriteFail(novelId: string): RewriteFailData | null {
  return rewriteNovelId === novelId && rewriteFailData ? rewriteFailData : loadRewriteFailData(novelId);
}

/**
 * 写后设定自检命中 → 右上角常驻告警通知（带「重新生成/忽略」操作）。
 * 仅对「正文必现清单漏写」弹窗；机构档案缺维度（org_archive_gap）属设定卡不完整、
 * 重新生成解决不了，且作者可能无权/无需硬编（背景机构），已降级为评价区低优先级提示，
 * 不再弹右上角常驻告警——需要时到「评价与优化」查看。
 * 切换章节/换小说即自动移除本通知（见 clearGapNotifIfMismatch），避免挂着旧章节的告警。
 */
export function fireGapNotif(
  novelId: string,
  chapterNo: number,
  gaps: SettingGap[],
  onRegenerate: () => void,
) {
  // 过滤出正文必现清单漏写（机构档案缺维度不弹窗，评价区低优先级提示承载）
  const contentGaps = gaps.filter((g) => g.kind !== "org_archive_gap");
  if (contentGaps.length === 0) return;
  if (gapsNotifId != null) {
    removeNotification(gapsNotifId);
    gapsNotifId = null;
  }
  gapsNotifNovel = novelId;
  gapsNotifChapter = chapterNo;
  gapsNotifId = notification.warning({
    duration: 0, // 常驻：等作者处理（重新生成 / 忽略 / 手动关闭）
    title: `设定检查：第 ${chapterNo} 章发现 ${contentGaps.length} 处问题`,
    message: (
      <div className="space-y-1">
        {contentGaps.map((g) => (
          <div key={`${g.rule}-${g.missing.join("-")}`} className="leading-5">
            按设定，本章应有 [{g.group.join(" 和 ")}]，但只写了 {g.present.join("、")}，还缺{" "}
            <span className="font-medium text-amber-900 dark:text-amber-100">{g.missing.join("、")}</span>
          </div>
        ))}
        <div className="pt-0.5 text-[11px] leading-5 opacity-75">
          这是按设定逐字比对出来的，如果本章确实不该有这一项可以忽略；否则建议重新生成，
          让 AI 补上。
        </div>
      </div>
    ),
    actions: (
      <>
        <button
          type="button"
          onClick={() => {
            closeNotification(gapsNotifId!);
            gapsNotifId = null;
            gapsNotifChapter = null;
            gapsNotifNovel = null;
            onRegenerate();
          }}
          className="rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-amber-700"
        >
          重新生成
        </button>
        <button
          type="button"
          onClick={() => {
            closeNotification(gapsNotifId!);
            gapsNotifId = null;
            gapsNotifChapter = null;
            gapsNotifNovel = null;
          }}
          className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          忽略
        </button>
      </>
    ),
  });
}

/** 切章 / 换小说：移除「设定自检」常驻通知（其操作目标是通知当时所在章，切走后不再适用）。
 *  WritingPanel 在 activeNo/novelId 变化时调用。 */
export function clearGapNotifIfMismatch(activeNo: number | null, novelId: string) {
  if (gapsNotifId != null && (gapsNotifChapter !== activeNo || gapsNotifNovel !== novelId)) {
    removeNotification(gapsNotifId);
    gapsNotifId = null;
    gapsNotifChapter = null;
    gapsNotifNovel = null;
  }
}

/** 联动重写中断 → 全局 Notification（右上角、error 类型、不可手动关闭）的同步 effect：
 *  - 状态置位时弹通知（数据更新先移除旧的再重弹），切页不隐藏、回来状态还原（同上，模块级持有）；
 *  - 15s 总展示时长只累计「页面可见时间」：document 不可见/组件卸载时暂停并保留剩余（写 localStorage），
 *    刷新或切页回来继续累计，累计满 15s 才自动关闭（此时才清模块态与本地状态）。
 *  @param setRewriteFail 本地状态 setter：计时耗尽自动关闭时把本地状态一并清空。 */
export function useRewriteFailNotif(
  novelId: string,
  rewriteFail: RewriteFailData | null,
  setRewriteFail: (v: RewriteFailData | null) => void,
) {
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
    // setRewriteFail 为 useState 返回的稳定 setter（调用方传入），不会触发额外重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId, rewriteFail]);
}
