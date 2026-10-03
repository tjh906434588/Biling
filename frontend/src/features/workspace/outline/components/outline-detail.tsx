/**
 * @file components/outline/outline-detail.tsx
 * 大纲页右侧「大纲详情」面板（展示型子组件，由 outline-panel.tsx 拆分）：
 * 标题区（视角/节奏徽标 + vN 版本浮层 + 重写 + 批准按钮）与正文区（目标/节拍/冲突/伏笔/线索）。
 * 不持有 state：仅按 props 渲染并回调；版本历史切换、批准、重写等状态编排仍在父组件。
 */
"use client";

import { useEffect, useState } from "react";
import type { Outline } from "@/lib/api";
import { TYPE_LABELS, loadFunctionLabels } from "@/constants";
import type { OutlineContent } from "./outline-utils";

interface Props {
  /** 详情当前展示的版本（父组件算好的 viewing：历史预览版或当前生效版）。 */
  viewing: Outline;
  /** 当前选中章的版本历史（同一章可多版本，轻量历史版本用）。 */
  versions: Outline[];
  /** 版本浮层开关（点击详情标题右侧的 vN 展开/收起）。 */
  showVersionModal: boolean;
  /** 解析后的详情正文（viewing.content 的强类型视图）。 */
  content: OutlineContent | undefined;
  /** 新增生成中：禁用「重写」入口（生成中的入口互斥）。 */
  generatingNew: boolean;
  /** 正在后台批准注入的大纲版本 id（按钮防抖 + 恢复「批准中…」）。 */
  approvingId: string | null;
  onToggleVersionModal: () => void;
  onCloseVersionModal: () => void;
  onSelectVersion: (id: string) => void;
  onRewrite: (chapterNo: number) => void;
  onApprove: (o: Outline) => void;
}

export default function OutlineDetail({
  viewing,
  versions,
  showVersionModal,
  content,
  generatingNew,
  approvingId,
  onToggleVersionModal,
  onCloseVersionModal,
  onSelectVersion,
  onRewrite,
  onApprove,
}: Props) {
  /** 章节功能 label 映射（枚举字典，后端单一源；拉取前显示原始 value）。 */
  const [fnLabels, setFnLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    void loadFunctionLabels().then(setFnLabels);
  }, []);
  return (
    <div className="panel flex max-h-[calc(100dvh-6rem)] min-h-0 flex-col overflow-hidden">
      <div className="panel-head shrink-0">
        <h3 className="panel-title">
          第 {viewing.chapter_no} 章大纲
          {viewing.title ? ` ${viewing.title}` : ""}
          {content?.pov ? <span className="ml-2 text-xs font-normal text-zinc-500">视角：{content.pov}</span> : null}
          {content?.chapter_function ? (
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              节奏：{fnLabels[content.chapter_function] ?? content.chapter_function}
            </span>
          ) : null}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          {/* 版本号按钮：点击展开内联版本浮层（替代原弹窗），点外部自动收起，不遮正文 */}
          <span className="relative inline-flex">
            <button
              type="button"
              onClick={onToggleVersionModal}
              className="btn btn-ghost px-3 py-1.5 text-sm font-medium"
              title="点击切换大纲版本"
            >
              <span>v{viewing.version_no}</span>
            </button>
            {showVersionModal && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  aria-hidden
                  onClick={onCloseVersionModal}
                />
                <div className="absolute right-0 top-full z-50 mt-2 max-h-[60vh] w-80 overflow-y-auto rounded-lg border border-zinc-200 bg-surface p-2 shadow-book dark:border-zinc-700 dark:bg-zinc-900">
                  <p className="px-2 py-1 text-[11px] leading-5 text-zinc-400">
                    同一章可保留多版大纲，点击版本预览；已批准标 ✓。
                  </p>
                  {versions.length === 0 ? (
                    <p className="py-4 text-center text-xs text-zinc-400">该章还没有任何大纲版本。</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {versions.map((v) => {
                        const active = v.id === viewing.id;
                        const approved = v.status === "approved";
                        return (
                          <li key={v.id}>
                            <button
                              type="button"
                              onClick={() => onSelectVersion(v.id)}
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
                                    <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] text-zinc-400 dark:bg-zinc-800 dark:text-zinc-400">
                                      未批准
                                    </span>
                                  )}
                                </span>
                                {v.title && <span className="truncate text-xs text-zinc-500">{v.title}</span>}
                              </span>
                              <span className="shrink-0 text-[11px] text-zinc-400">
                                {new Date(v.created_at).toLocaleString("zh-CN", {
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </span>
          {/* 重写当前章大纲：复用新增大纲弹窗，章节号锁定为本章（生成的新版本与旧版本各自独立） */}
          <button
            type="button"
            onClick={() => onRewrite(viewing.chapter_no)}
            disabled={generatingNew}
            className="btn btn-ghost px-3 py-1.5 text-sm font-medium"
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
              className="btn btn-approve"
              onClick={() => onApprove(viewing)}
              disabled={approvingId !== null}
            >
              {approvingId !== null ? "批准中…" : "批准此版本"}
            </button>
          ) : (
            <span className="rounded bg-green-100 px-2 py-1 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
              正在使用
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
            <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">节拍</h4>
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
            <h4 className="mb-1.5 text-xs font-semibold text-green-600 dark:text-green-400">回收伏笔</h4>
            <ul className="flex flex-col gap-1">
              {content.resolve_foreshadowing.map((r, i) => (
                <li key={i} className="rounded-lg border border-green-200 bg-green-50 p-2 text-sm dark:border-green-900 dark:bg-green-950">
                  {r.how}
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
  );
}
