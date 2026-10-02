"use client";

/**
 * @file topbar.tsx
 * 书架页应用顶栏：品牌标识 + 「导出日志」入口（排查问题用）。
 * 纯展示组件；导出链接直连后端 /diagnostics/export（打包后端日志 + 前端日志 +
 * 系统信息为 zip），桌面版由 Electron 壳层拦截下载弹保存对话框。
 */
import Brand from "@/components/brand";
import { BASE } from "@/constants";

/** 书架页顶栏：紧凑工具栏，不是营销导航。 */
export function Topbar() {
  return (
    <>
      {/* ── 应用顶栏：紧凑工具栏，不是营销导航 ──────────────────── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-paper/90 px-3 backdrop-blur-md sm:px-4">
        <Brand size="sm" showLatin={false} />
        <span aria-hidden className="h-4 w-px bg-zinc-300" />
        <p className="hidden text-[12px] text-zinc-500 sm:block">AI 小说工作台</p>
        {/* 导出日志（排查问题用）：后端打包后端日志 + 前端日志 + 系统信息为 zip；
            桌面版由 Electron 壳层拦截下载弹保存对话框，托盘右键也有同一入口兜底 */}
        <a
          href={`${BASE}/diagnostics/export`}
          download
          title="导出日志（出问题时发给作者排查）"
          aria-label="导出日志"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3a3 3 0 0 0-3 3v.17A3 3 0 0 0 6 9v2a3 3 0 0 0 3 3v4.5A2.5 2.5 0 0 1 6.5 21h-1a.5.5 0 0 0 0 1h1a3.5 3.5 0 0 0 3.5-3.5V12h4v6.5a3.5 3.5 0 0 0 3.5 3.5h1a.5.5 0 0 0 0-1h-1a2.5 2.5 0 0 1-2.5-2.5V14a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3A3 3 0 0 0 12 3z" />
          </svg>
        </a>
      </header>
    </>
  );
}
