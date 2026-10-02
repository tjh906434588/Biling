/**
 * @file sidebar.tsx
 * 工作台宽屏侧栏（IDE 式工具面板，lg 起显示）：按 NAV_GROUPS 分组渲染导航项，
 * 底部「写作指令」入口与引导文案。
 * 关键机制：纯展示组件，激活态与切换回调均由父级传入（tab + onSelectTab）；
 * NavIcon 从 ICONS 查表渲染内联 SVG path，激活项带左侧高亮竖条。
 */
"use client";

import { ICONS, NAV_GROUPS } from "./workspace-config";
import type { Tab } from "@/types/workspace";

/** 按名称渲染导航图标（从 ICONS 查表取内联 SVG path） */
function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      aria-hidden
      className="h-[15px] w-[15px] shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

/** 侧栏导航项渲染：图标 + 文字（宽屏用），激活项带左侧高亮竖条 */
function SideItem({
  item,
  active,
  onSelect,
}: {
  item: [Tab, string, keyof typeof ICONS];
  active: boolean;
  onSelect: (t: Tab) => void;
}) {
  const [k, label, icon] = item;
  return (
    <li key={k}>
      <button
        className={`relative flex w-full items-center gap-2.5 rounded-md py-[7px] pl-3 pr-2 text-left text-[13.5px] transition-colors ${
          active
            ? "bg-zinc-100 font-medium text-zinc-900"
            : "text-zinc-500 hover:bg-zinc-100/60 hover:text-zinc-900"
        }`}
        onClick={() => onSelect(k)}
      >
        {active && (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-seal"
          />
        )}
        <span className={active ? "text-seal" : "text-zinc-400"}>
          <NavIcon name={icon} />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    </li>
  );
}

export default function Sidebar({
  tab,
  onSelectTab,
  onOpenPrompts,
}: {
  tab: Tab;
  onSelectTab: (t: Tab) => void;
  onOpenPrompts: () => void;
}) {
  return (
    <aside
      className="hidden w-[188px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-zinc-200 bg-sunken/40 px-2.5 py-4 lg:flex"
      aria-label="工作台导航"
    >
      {NAV_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="mb-1.5 px-3 text-[10.5px] tracking-[0.22em] text-zinc-400">{g.label}</p>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((item) => (
              <SideItem key={item[0]} item={item} active={tab === item[0]} onSelect={onSelectTab} />
            ))}
          </ul>
        </div>
      ))}

      <div className="mt-auto flex flex-col gap-2 px-2.5 pb-2">
        <button
          type="button"
          onClick={onOpenPrompts}
          title="给 AI 助手立写作规矩（整本书生效）"
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800"
        >
          <svg
            aria-hidden
            className="h-[15px] w-[15px] shrink-0 text-zinc-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          写作指令
        </button>
        <p className="px-2 text-[10.5px] leading-4 text-zinc-400">
          你标记为「不可变」的设定，AI 写的时候必须遵守<br />大纲你确认后，会自动登记到记录里
        </p>
      </div>
    </aside>
  );
}
