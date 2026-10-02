/**
 * @file writing/info-modal.tsx
 * 「谁知道了什么（可选）」信息控制弹窗：本地草稿编辑，点「完成」才提交到 form，
 * 点「取消」丢弃本次改动、点「清空」只清本地草稿（不点确定则原内容仍保留）。
 * 纯展示组件：草稿值/提交/关闭回调全部由 writing-panel 传入，草稿 state 留在父组件。
 */
"use client";

import Modal from "@/components/modal";
import type { InfoControl } from "@/lib/api";
import type { InfoDraft } from "./panel-utils";

/** 信息控制弹窗 props：草稿值、变更/提交/关闭回调由 writing-panel 传入。 */
interface InfoModalProps {
  open: boolean;
  onClose: () => void;
  draft: InfoDraft;
  /** 当前本章生效的合并结果（全局默认 + 此前已定稿章节链 + 本章），只读展示 */
  effective: InfoControl;
  onDraftChange: (d: InfoDraft) => void;
  /** 点「完成」：把草稿作为本章信息控制并关闭弹窗（父组件实现）。 */
  onSubmit: () => void;
}

/** 谁知道了什么（可选）：信息控制弹窗（本地 draft，取消丢弃 / 清空只清本地 / 完成才提交）。 */
export function InfoModal({ open, onClose, draft, effective, onDraftChange, onSubmit }: InfoModalProps) {
  // 生效合并里的非空字段（此前定稿章节已确立的信息边界），只读展示给作者参考
  const effEntries = (
    [
      ["读者已知", effective.reader_knows],
      ["主角已知", effective.protagonist_knows],
      ["必须向读者隐瞒", effective.must_hide],
      ["只能点到为止", effective.hint_only],
    ] as const
  ).filter(([, v]) => v.trim());
  return (
    <Modal
      open={open}
      title="谁知道了什么（可选）"
      subtitle="本章信息控制：随本章生成/重写生效，之后章节自动沿用，直到有新的章覆盖。这些是「信息边界」：正文可以不体现，但绝不能与它们冲突。"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost px-4 py-1.5"
          >
            取消
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onDraftChange({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" })}
              className="btn btn-ghost px-4 py-1.5"
            >
              清空
            </button>
            <button
              type="button"
              onClick={onSubmit}
              className="btn btn-primary px-4 py-1.5"
            >
              完成
            </button>
          </div>
        </div>
      }
    >
      <div className="grid gap-3">
        {effEntries.length > 0 && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-xs leading-5 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
            <span className="font-medium text-zinc-600 dark:text-zinc-300">当前本章生效（含此前已定稿章节的）：</span>
            {effEntries.map(([label, v]) => (
              <span key={label} className="mt-0.5 block">
                {label}：{v}
              </span>
            ))}
          </div>
        )}
        <input
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          placeholder="读者已知：…"
          value={draft.reader_knows}
          onChange={(e) => onDraftChange({ ...draft, reader_knows: e.target.value })}
        />
        <input
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          placeholder="主角已知：…"
          value={draft.protagonist_knows}
          onChange={(e) => onDraftChange({ ...draft, protagonist_knows: e.target.value })}
        />
        <input
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          placeholder="必须向读者隐瞒：…"
          value={draft.must_hide}
          onChange={(e) => onDraftChange({ ...draft, must_hide: e.target.value })}
        />
        <input
          className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          placeholder="只能点到为止（伏笔暗示）：…"
          value={draft.hint_only}
          onChange={(e) => onDraftChange({ ...draft, hint_only: e.target.value })}
        />
        <p className="text-xs leading-relaxed text-zinc-500">
          全部留空则让 AI 自己把握。点「完成」才保存；点「清空」只清当前输入、不立即生效；点「取消」则放弃本次改动。
        </p>
      </div>
    </Modal>
  );
}
