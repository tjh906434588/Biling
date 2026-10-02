"use client";

/**
 * @file topbar.tsx
 * 书架页应用顶栏：页面标题 + 「导入」+「导出日志」入口。
 * 品牌「笔灵 Biling」已由全局自绘标题栏（TitleBar）承载，这里不再重复展示。
 * - 导入：选择备份 zip → onImport 交给书架页（上传 → 还原新书 → 跳转续写）。
 * - 导出日志：直连后端 /diagnostics/export（打包后端日志 + 前端日志 + 系统信息为 zip），
 *   桌面版由 Electron 壳层拦截下载弹保存对话框。
 */
import { useRef } from "react";
import { BASE } from "@/constants";

/** 书架页顶栏：紧凑工具栏，不是营销导航。 */
export function Topbar({
  onImport,
  busy,
}: {
  /** 用户选择了备份 zip 后回调（文件上传 + 还原 + 跳转由书架页实现） */
  onImport?: (file: File) => void;
  /** 书架页有操作进行中时禁用按钮，防止重复提交 */
  busy?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-paper/90 px-3 backdrop-blur-md sm:px-4">
      <h1 className="font-serif text-[14.5px] font-medium leading-tight text-zinc-900">
        书架
      </h1>
      <span aria-hidden className="h-4 w-px bg-zinc-300" />
      <p className="hidden text-[12px] text-zinc-500 sm:block">AI 小说工作台</p>
      <div className="ml-auto flex items-center gap-2">
        {/* 导入整本书备份（zip → 还原为一本内容完全相同的新书，无缝续写） */}
        <button
          type="button"
          title="导入整本书备份（从 zip 还原，内容完全一样，可直接续写）"
          aria-label="导入"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4m0 0 4 4m-4-4-4 4" />
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <span className="hidden text-[12px] sm:inline">导入</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && onImport) void onImport(f);
            e.target.value = ""; // 允许再次选择同一个文件
          }}
        />
        {/* 导出日志（排查问题用）：后端打包后端日志 + 前端日志 + 系统信息为 zip；
            桌面版由 Electron 壳层拦截下载弹保存对话框，托盘右键也有同一入口兜底 */}
        <a
          href={`${BASE}/diagnostics/export`}
          download
          title="导出日志（出问题时发给作者排查）"
          aria-label="导出日志"
          className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3a3 3 0 0 0-3 3v.17A3 3 0 0 0 6 9v2a3 3 0 0 0 3 3v4.5A2.5 2.5 0 0 1 6.5 21h-1a.5.5 0 0 0 0 1h1a3.5 3.5 0 0 0 3.5-3.5V12h4v6.5a3.5 3.5 0 0 0 3.5 3.5h1a.5.5 0 0 0 0-1h-1a2.5 2.5 0 0 1-2.5-2.5V14a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3A3 3 0 0 0 12 3z" />
          </svg>
        </a>
      </div>
    </header>
  );
}
