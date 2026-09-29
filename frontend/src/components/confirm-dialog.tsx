/**
 * @file confirm-dialog.tsx
 * 全站统一的确认弹窗：替换浏览器原生 confirm，用于删除等危险操作的二次确认。
 * 纯受控组件（open 由父组件控制），确认/取消通过回调通知父组件，自身无状态与副作用。
 */
"use client";

import type { ReactNode } from "react";

interface ConfirmDialogProps {
  /** 是否显示弹窗（受控，由父组件决定开合） */
  open: boolean;
  /** 标题 */
  title: string;
  /** 正文内容（支持 JSX；white-space-pre-line 保留换行） */
  message?: ReactNode;
  /** 确认按钮文字，默认「确认」 */
  confirmText?: string;
  /** 取消按钮文字，默认「取消」 */
  cancelText?: string;
  /** 确认按钮风格：danger=红色警示（默认）/ primary=主色 */
  tone?: "danger" | "primary";
  /** 点击确认按钮的回调 */
  onConfirm: () => void;
  /** 点击取消按钮的回调 */
  onCancel: () => void;
}

/** 全站统一的确认弹窗（替换浏览器原生 confirm）。 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        {message != null && (
          <div className="mt-2 whitespace-pre-line text-sm text-zinc-500 dark:text-zinc-400">{message}</div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            className={
              tone === "danger"
                ? "rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500"
                : "rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            }
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
