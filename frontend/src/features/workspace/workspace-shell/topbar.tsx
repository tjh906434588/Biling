/**
 * @file topbar.tsx
 * 工作台顶栏（48px 工具栏）：返回书架链接 + 书名（由 id 反查得到，未命名时兜底文案）+ 本地运行标识。
 * 关键机制：纯展示组件，仅接收 novelTitle；书名由页面主组件负责拉取。
 */
"use client";

import Link from "next/link";

export default function Topbar({ novelTitle }: { novelTitle: string }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-paper/90 px-3 backdrop-blur-md">
      <Link
        href="/"
        className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        title="返回书架"
      >
        <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M11 18l-6-6 6-6" />
        </svg>
        <span className="hidden sm:inline">书架</span>
      </Link>

      <span aria-hidden className="h-4 w-px shrink-0 bg-zinc-300" />

      <div className="min-w-0 flex-1">
        <h1 className="truncate font-serif text-[14.5px] font-medium leading-tight text-zinc-900">
          {novelTitle || "未命名作品"}
        </h1>
      </div>

      <span className="hidden items-center gap-1.5 font-mono text-[11px] text-zinc-400 md:flex">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-jade" />
        本地运行
      </span>
    </header>
  );
}
