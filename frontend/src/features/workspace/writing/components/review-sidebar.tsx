/**
 * @file writing/review-sidebar.tsx
 * 写作页右侧「评价与优化」常驻侧栏：按剩余空间比例分配（窄/中/宽） + 重新评价提示 +
 * 评价卡片 ReviewCard + 空态（后台任务加载 / 无评价引导）。
 * 纯展示组件：评价数据、运行状态与回调全部由 writing-panel 传入，组件内无状态。
 */
"use client";

import { REVIEW_RATIO_PRESETS } from "@/constants";
import type { ChapterDetail, ChapterVersion, QualityReview } from "@/lib/api";
import { ReviewCard } from "./review-card";

/** 评价与优化侧栏 props：数据与回调全部由 writing-panel 传入。 */
interface ReviewSidebarProps {
  reviewRatio: number;
  onReviewRatio: (ratio: number) => void;
  detail: ChapterDetail | null;
  /** 正文在最近一次评价后被修改过：显示「重新评价」提示条。 */
  reviewStale: boolean;
  currentReview: QualityReview | null;
  onReview: () => void;
  reviewing: boolean;
  reviewTaskRunning: boolean;
  selectedVersion: ChapterVersion | null;
  /** 当前选中版本是否「刚生成」（3 分钟内）：空态文案提示作者手动评价。 */
  isRecentlyGenerated: boolean;
  /** 后台评价任务是否对应当前章节（决定空态显示「评价处理中」加载态）。 */
  reviewBusyForChapter: boolean;
  onRevise: (r: QualityReview, authorInput?: { note?: string; disagreements?: Record<number, string> }) => void;
  revising: boolean;
  /** 打开「查看生成过程」弹窗（评价 / 优化各一）。 */
  onShowReviewRun: () => void;
  onShowReviseRun: () => void;
}

/** 评价与优化常驻侧栏（按剩余空间比例分配）。 */
export function ReviewSidebar({
  reviewRatio,
  onReviewRatio,
  detail,
  reviewStale,
  currentReview,
  onReview,
  reviewing,
  reviewTaskRunning,
  selectedVersion,
  isRecentlyGenerated,
  reviewBusyForChapter,
  onRevise,
  revising,
  onShowReviewRun,
  onShowReviseRun,
}: ReviewSidebarProps) {
  return (
    <div className="panel flex max-h-[45vh] min-h-0 min-w-0 flex-col xl:max-h-none">

        <div className="panel-head shrink-0">
          <h3 className="panel-title">评价与优化</h3>
          <div className="flex items-center gap-2">
            {/* 比例三档：窄/中/宽一键切换 */}
            <div className="hidden items-center gap-0.5 rounded border border-zinc-200 p-0.5 2xl:flex dark:border-zinc-700">
              {REVIEW_RATIO_PRESETS.map(([label, ratio]) => {
                const on = Math.round(reviewRatio) === ratio;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onReviewRatio(ratio)}
                    aria-pressed={on}
                    title={`评价栏占剩余空间 ${ratio}%`}
                    className={`rounded px-1.5 py-0.5 text-[11px] leading-none transition-colors ${
                      on
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="@container min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          {detail ? (
            <>
              {reviewStale && currentReview != null && (
                <div className="mb-2.5 flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-500/10">
                  <p className="min-w-0 flex-1 text-xs leading-5 text-amber-800 dark:text-amber-200">
                    正文已修改，现有评价基于修改前的内容，已不对应当前版本。点击「重新评价」对本版本重新评价。
                  </p>
                  <button
                    type="button"
                    onClick={onReview}
                    disabled={reviewing || reviewTaskRunning || !selectedVersion}
                    className="btn btn-primary shrink-0 px-3 py-1 text-xs font-medium"
                  >
                    {reviewing ? "评价中…" : reviewTaskRunning ? "已有评价任务进行中…" : "重新评价"}
                  </button>
                </div>
              )}
              {currentReview ? (
              <ReviewCard
                review={currentReview}
                onRevise={onRevise}
                revising={revising}
                activeVersionId={selectedVersion?.id ?? null}
                viewButton={
                  revising ? (
                    <button
                      type="button"
                      onClick={onShowReviseRun}
                      className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                    >
                      查看生成过程
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-300 p-5 text-center dark:border-zinc-700">
                {!reviewing && reviewBusyForChapter ? (
                  /* 评价任务进行中：显示加载态——手动评价/优化在后台异步跑（约几分钟），
                     此时不打扰、也不让作者重复点手动评价（会撞 409）。
                     任务完成由 agent-task-toasts 派发事件触发本面板刷新，评价会自动显示。 */
                  <div className="flex flex-col items-center gap-2.5 py-1">
                    <svg aria-hidden viewBox="0 0 24 24" fill="none" className="h-6 w-6 animate-spin text-seal">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                    <p className="text-xs leading-6 text-zinc-500 dark:text-zinc-400">
                      正在评价第 {detail.chapter_no} 章（正在后台处理，约几分钟，完成后会自动显示）…
                    </p>
                    <p className="text-xs leading-5 text-zinc-400 dark:text-zinc-500">
                      评价完成后会自动显示在这里，无需重复操作
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-xs leading-6 text-zinc-500 dark:text-zinc-400">
                      {selectedVersion ? (
                        <>
                          当前选中的第{selectedVersion.version_no}版正文还没有评价。
                          {reviewTaskRunning ? (
                            <>当前已有评价任务在后台运行，请等待其完成后再手动评价。</>
                          ) : isRecentlyGenerated ? (
                            <>
                              该版本刚生成，还没有评价。点下方「评价本章」手动评价。
                            </>
                          ) : (
                            <>点下方「评价本章」，AI 会对照全书设定、已埋的伏笔逐项打分。</>
                          )}
                        </>
                      ) : (
                        "该章还没有选定版本的正文，先在界面生成并选定一版，再回来评价。"
                      )}
                    </p>
                    <div className="mt-2.5 flex items-center justify-center gap-2">
                      <button
                        onClick={onReview}
                        disabled={reviewing || reviewTaskRunning || !selectedVersion}
                        className="btn btn-primary px-3 py-1.5 text-xs font-medium"
                      >
                        {reviewing ? "评价中…" : reviewTaskRunning ? "已有评价任务进行中…" : "评价本章"}
                      </button>
                      {reviewing && (
                        <button
                          type="button"
                          onClick={onShowReviewRun}
                          className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                        >
                          查看生成过程
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
            }
            </>
          ) : (
            <p className="text-center text-xs text-zinc-400">请先在左侧章节目录选择一章。</p>
          )}
        </div>
      </div>
  );
}
