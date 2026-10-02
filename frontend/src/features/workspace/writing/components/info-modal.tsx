/**
 * @file writing/info-modal.tsx
 * 「谁知道了什么（可选）」信息控制弹窗：
 * - 编辑模式（生成/重写本章时）：本地草稿编辑，点「完成」才提交、点「取消」丢弃、点「清空」只清本地；
 * - 只读模式（生成后查看）：展示本章已填的四个字段（读者已知 / 主角已知 / 必须隐瞒 / 点到为止），
 *   以及「此前已定稿章节沿用下来」的生效信息边界，仅供查看不可编辑。
 * 纯展示组件：草稿值/提交/关闭回调全部由 writing-panel 传入，草稿 state 留在父组件。
 */
"use client";

import type { ReactNode } from "react";
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
  /** 只读查看模式：生成后查看已填信息控制用；不可编辑，仅展示 */
  readonly?: boolean;
}

/** 四个信息控制字段的展示元信息：图标 + 标题 + 一句语义提示 */
const FIELDS: {
  key: keyof InfoDraft;
  label: string;
  hint: string;
  icon: ReactNode;
}[] = [
  {
    key: "reader_knows",
    label: "读者已知",
    hint: "不得当作未知重新解释",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    ),
  },
  {
    key: "protagonist_knows",
    label: "主角已知",
    hint: "主角不得表现无知或遗忘",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
      </svg>
    ),
  },
  {
    key: "must_hide",
    label: "必须向读者隐瞒",
    hint: "正文绝不提前泄露，只埋伏笔",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    ),
  },
  {
    key: "hint_only",
    label: "只能点到为止",
    hint: "只可暗示，不可点破",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M9 18h6M10 21h4" />
        <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1.1 2h4.8c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3Z" />
      </svg>
    ),
  },
];

/** 谁知道了什么（可选）：信息控制弹窗（编辑 / 只读查看两种模式）。 */
export function InfoModal({ open, onClose, draft, effective, onDraftChange, onSubmit, readonly = false }: InfoModalProps) {
  // 生效合并里的非空字段（含此前已定稿章节沿用的信息边界）
  const effEntries: { key: keyof InfoDraft; label: string; value: string }[] = (
    [
      ["reader_knows", "读者已知"],
      ["protagonist_knows", "主角已知"],
      ["must_hide", "必须向读者隐瞒"],
      ["hint_only", "只能点到为止"],
    ] as const
  )
    .map(([key, label]) => ({ key, label, value: effective[key] ?? "" }))
    .filter((e) => e.value.trim());
  // 纯由「此前已定稿章节」沿用下来的（本章未填的），在查看时单独提示
  const inherited = effEntries.filter((e) => !(draft[e.key] ?? "").trim());

  return (
    <Modal
      open={open}
      title={readonly ? "信息控制" : "谁知道了什么（可选）"}
      subtitle={
        readonly
          ? "本章已填写的信息控制。如需修改，请重新生成本章时在弹窗里调整（不能事后单独编辑）。"
          : "本章信息控制：随本章生成/重写生效，之后章节自动沿用，直到有新的章覆盖。这些是「信息边界」：正文可以不体现，但绝不能与它们冲突。"
      }
      maxWidth={readonly ? "max-w-md" : undefined}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {readonly ? (
            <button
              type="button"
              onClick={onClose}
              className="btn btn-primary px-5 py-1.5"
            >
              关闭
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>
      }
    >
      {readonly ? (
        /* ── 只读查看：四个字段卡片展示 ── */
        <div className="flex flex-col gap-2.5">
          {FIELDS.map((f) => {
            const v = (draft[f.key] ?? "").trim();
            return (
              <div
                key={f.key}
                className="flex items-center gap-3 rounded-xl border border-zinc-200/80 bg-surface px-3 py-2.5 dark:border-zinc-700/60"
              >
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sunken text-zinc-500 dark:text-zinc-400">
                  {f.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{f.label}</span>
                    <span className="shrink-0 text-[10px] text-zinc-400">{f.hint}</span>
                  </div>
                  <div className="mt-0.5 text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                    {v ? (
                      v
                    ) : (
                      <span className="text-zinc-400 dark:text-zinc-500">未填写</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {/* 此前已定稿章节沿用下来的信息边界（本章未重填的），琥珀色提示 */}
          {inherited.length > 0 && (
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2.5 dark:border-amber-900/40 dark:bg-amber-950/25">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                  <path d="M4 12h10M9 7l5 5-5 5" />
                </svg>
                沿用此前已定稿章节的信息边界
              </div>
              <div className="mt-1.5 space-y-1">
                {inherited.map((e) => (
                  <div key={e.key} className="flex gap-2 text-xs leading-relaxed">
                    <span className="w-16 shrink-0 text-zinc-500 dark:text-zinc-400">{e.label}</span>
                    <span className="text-zinc-700 dark:text-zinc-300">{e.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ── 编辑模式：四个输入框 + 生效提示 ── */
        <div className="grid gap-3">
          {effEntries.length > 0 && (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-xs leading-5 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
              <span className="font-medium text-zinc-600 dark:text-zinc-300">当前本章生效（含此前已定稿章节的）：</span>
              {effEntries.map((e) => (
                <span key={e.key} className="mt-0.5 block">
                  {e.label}：{e.value}
                </span>
              ))}
            </div>
          )}
          {FIELDS.map((f) => (
            <input
              key={f.key}
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder={`${f.label}：…`}
              value={draft[f.key]}
              onChange={(e) => onDraftChange({ ...draft, [f.key]: e.target.value })}
            />
          ))}
          <p className="text-xs leading-relaxed text-zinc-500">
            全部留空则让 AI 自己把握。点「完成」才保存；点「清空」只清当前输入、不立即生效；点「取消」则放弃本次改动。
          </p>
        </div>
      )}
    </Modal>
  );
}
