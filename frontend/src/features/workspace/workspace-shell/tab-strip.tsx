/**
 * @file tab-strip.tsx
 * 工作台窄屏顶部标签条（lg 以下显示，可横向滚动）：展平 FLAT_TABS 渲染纯文字标签。
 * 关键机制：纯展示组件，激活态与切换回调均由父级传入（tab + onSelectTab）。
 */
"use client";

import { FLAT_TABS } from "./workspace-config";
import type { Tab } from "@/types/workspace";

export default function TabStrip({
  tab,
  onSelectTab,
}: {
  tab: Tab;
  onSelectTab: (t: Tab) => void;
}) {
  return (
    <nav
      className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200/70 bg-sunken/30 px-3 py-2 lg:hidden"
      aria-label="工作台导航"
    >
      {FLAT_TABS.map(([k, label]) => {
        const active = tab === k;
        return (
          <button
            key={k}
            className={`shrink-0 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
              active
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
            onClick={() => onSelectTab(k)}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
