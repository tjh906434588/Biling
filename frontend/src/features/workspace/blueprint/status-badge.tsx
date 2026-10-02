/**
 * @file blueprint/status-badge.tsx
 * 蓝图生效状态徽章（纯展示）：生效中显示「正在使用」，未生效显示「未使用」。
 * 由 blueprint-panel.tsx 拆出，供版本列表项与详情头部共用（原 statusBadge 内联函数）。
 */
"use client";

import type { Blueprint } from "@/lib/api";

/** 生效状态徽章（纯展示）：生效中 / 未生效。 */
export function StatusBadge({ status }: { status: Blueprint["status"] }) {
  return status === "active" ? (
    <span className="shrink-0 whitespace-nowrap rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">正在使用</span>
  ) : (
    <span className="shrink-0 whitespace-nowrap rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">未使用</span>
  );
}
