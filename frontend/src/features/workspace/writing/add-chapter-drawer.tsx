/**
 * @file writing/add-chapter-drawer.tsx
 * 写作页「新增章节 / 重新生成正文」右侧滑入抽屉：沿用大纲开关 + 章节名称（自由草稿时）+
 * 本章节奏定位 + 本章目标 + 信息控制入口 + 底部生成按钮与「查看生成过程」。
 * 纯展示组件：表单值、大纲数据与回调全部由 writing-panel 传入，表单 state 留在父组件。
 */
"use client";

import { FUNCTIONS } from "@/constants";
import type { Outline } from "@/lib/api";
import { CostHint } from "@/lib/ai-status";
import InfoTip from "@/components/info-tip";
import { AutoTextarea } from "./auto-textarea";
import type { GenForm } from "./panel-utils";

/** 新增章节/重新生成抽屉 props：数据与回调全部由 writing-panel 传入。 */
interface AddChapterDrawerProps {
  regenerateNo: number | null;
  form: GenForm;
  onFormChange: (f: GenForm) => void;
  nextNo: number;
  /** 目标章已批大纲：无已批大纲时不显示任何规划提示。 */
  targetOutline: Outline | null;
  useOutline: boolean;
  onToggleUseOutline: (on: boolean) => void;
  generating: boolean;
  onOpenInfo: () => void;
  infoFilledCount: number;
  onGenerate: () => void;
  /** 打开「查看生成过程」弹窗（仅生成中显示）。 */
  onViewRun: () => void;
  onClose: () => void;
}

/** 新增章节 / 重新生成正文抽屉（右侧滑入内联面板）。 */
export function AddChapterDrawer({
  regenerateNo,
  form,
  onFormChange,
  nextNo,
  targetOutline,
  useOutline,
  onToggleUseOutline,
  generating,
  onOpenInfo,
  infoFilledCount,
  onGenerate,
  onViewRun,
  onClose,
}: AddChapterDrawerProps) {
  return (
    <>
      <div
        className="fixed inset-0 z-[90] bg-black/30"
        aria-hidden
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className="fixed right-0 top-0 z-[95] flex h-[100dvh] w-[440px] max-w-[92vw] flex-col border-l border-zinc-200 bg-surface shadow-book dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-700">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {regenerateNo != null ? "重新生成章节正文" : "新增章节"}
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              {regenerateNo != null
                ? `将重新写第 ${form.chapter_no} 章（会另存新的一版，原稿保留），标题 / 大纲目标 / 本章节奏定位等均可修改。`
                : `将追加为第 ${nextNo} 章（目录最新一章的下一章）。写正文前会先让你确认这一章的安排；生成后是草稿，确认满意后定稿。`}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-3">
        {/* 沿用大纲开关：仅该章有已批大纲时出现（无已批大纲时不显示任何规划提示） */}
        {targetOutline && (
          <>
            <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900">
              <span className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300">
                沿用该章已确认的大纲
                <InfoTip portal>
                  <p className="font-medium text-zinc-700 dark:text-zinc-200">第 {form.chapter_no} 章有已确认的大纲</p>
                  开启：自动填到下方「本章目标」，写正文前仍会弹出本章规划供你确认沿用或另选
                  <br />关闭：不用大纲，让 AI 自由发挥，标题由 AI 根据内容生成
                </InfoTip>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={useOutline}
                onClick={() => onToggleUseOutline(!useOutline)}
                disabled={generating}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  useOutline ? "bg-seal" : "bg-zinc-300 dark:bg-zinc-600"
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    useOutline ? "translate-x-4" : ""
                  }`}
                />
              </button>
            </div>
            {useOutline ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-xs leading-5 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                将基于已确认的大纲：第 {targetOutline.chapter_no} 章
                {targetOutline.title ? `《${targetOutline.title}》` : ""}（大纲内容已自动填入下方「本章目标」，
                写正文前仍会弹出本章规划，你可确认沿用或另选一套）。
              </div>
            ) : (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-5 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400">
                已关闭大纲沿用：本章不用大纲，让 AI 自由发挥，标题由 AI 根据内容生成
                （写正文前仍会弹出本章规划供你确认）。
              </div>
            )}
          </>
        )}

        {/* 自由草稿（未沿用大纲）：章节名称可手动填（带标签，避免高度错位） */}
        {!useOutline && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">章节名称</span>
            <input
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder="章节标题（留空则 AI 自动生成）"
              value={form.title}
              onChange={(e) => onFormChange({ ...form, title: e.target.value })}
              disabled={generating}
            />
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">本章节奏定位</span>
          <select
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            value={form.chapter_function}
            onChange={(e) => onFormChange({ ...form, chapter_function: e.target.value })}
            disabled={generating}
          >
            <option value="">本章节奏定位：自动判定</option>
            {FUNCTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                本章节奏定位：{l}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">本章目标 / 写作要求</span>
          <AutoTextarea
            value={form.outline}
            onChange={(v) => onFormChange({ ...form, outline: v })}
            maxHeight={200}
            disabled={generating}
            placeholder={
              targetOutline && useOutline
                ? "已自动来自该章已确认的大纲（可微调）。写正文前仍会弹出本章规划供确认"
                : "本章目标/写作要求（可选）。写正文前会弹出本章规划供确认，不填则按蓝图自动规划"
            }
            className="resize-none rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </label>

        {/* 信息控制：高级可选项，点开独立弹窗填写/清空 */}
        <div className="flex items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="text-xs text-zinc-500">
            谁知道了什么（可选）
            <InfoTip portal>
              <p className="font-medium text-zinc-700 dark:text-zinc-200">控制「谁知道了什么」</p>
              防止 AI 提前剧透或逻辑穿帮；全部留空则让 AI 自己把握。
              <span className="mt-1.5 block text-zinc-400">
                读者已知 / 主角已知 / 必须向读者隐瞒 / 只能点到为止（伏笔暗示）
              </span>
            </InfoTip>
          </span>
          <button
            type="button"
            onClick={onOpenInfo}
            disabled={generating}
            className="btn btn-ghost px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
          >
            {infoFilledCount > 0 ? `已填 ${infoFilledCount} 项 · 编辑` : "填写"}
          </button>
        </div>
      </div>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-700">
          <button
            type="button"
            onClick={onClose}
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
              onClick={onGenerate}
              disabled={generating}
              className="btn btn-primary px-4 py-1.5 disabled:opacity-50"
            >
              {generating ? "生成中…" : "生成正文"}
            </button>
            {/* 点击生成后出现：打开生成过程弹窗（与大纲新增弹窗一致，仅生成中显示） */}
            {generating && (
              <button
                type="button"
                onClick={onViewRun}
                className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
              >
                查看生成过程
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
