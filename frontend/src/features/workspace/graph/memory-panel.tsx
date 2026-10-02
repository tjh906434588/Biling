/**
 * @file graph/memory-panel.tsx
 * 角色状态记忆回顾面板（纯展示，由 graph-panel.tsx 拆出）：
 * 左栏列出每个角色当前状态与确立章节（含「存疑」标记）、健康度徽章、
 * 进度提示与问题清单；数据仅来自 memory prop。
 */
"use client";

import type { MemoryReview } from "@/lib/api";

/** 角色状态面板：头部（计数/健康度/进度）+ 状态列表 + 问题清单。 */
export function MemoryPanel({ memory }: { memory: MemoryReview }) {
  return (
    <section className="panel flex w-[min(24rem,40%)] shrink-0 flex-col">
      <div className="panel-head shrink-0">
        <h2 className="panel-title">
          角色状态
          <span className="text-xs font-normal text-zinc-500">
            {Object.keys(memory.character_states).length} 个角色
          </span>
        </h2>
        <span className="flex items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              memory.healthy ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
            }`}
          >
            {memory.healthy ? "健康" : "需关注"}
          </span>
          <span className="panel-hint">进度：第 {memory.progress_chapter} 章</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {Object.keys(memory.character_states).length === 0 ? (
          memory.progress_chapter > 0 ? (
            <p className="text-xs text-zinc-400">还缺角色状态。写完章节后点『记进 AI 记忆』重新提取一次即可</p>
          ) : (
            <p className="text-xs text-zinc-400">还没有章节。写完章节后，AI 会自动整理出每个角色当前的状态</p>
          )
        ) : (
          <ul className="flex flex-col gap-2">
            {Object.entries(memory.character_states).map(([name, st]) => (
              <li key={name} className="flex gap-2 text-xs">
                <span className="w-20 shrink-0 break-words font-medium leading-5 text-zinc-500 dark:text-zinc-400">{name}</span>
                <span className="min-w-0 flex-1 break-words font-semibold leading-5 text-zinc-800 dark:text-zinc-200">
                  {st.state}
                  <span className="font-normal text-zinc-400 dark:text-zinc-500"> · 第{st.chapter_no}章</span>
                  {st.confidence === "low" && (
                    <span className="ml-1.5 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300">存疑</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {memory.issues.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <span className="font-semibold">问题清单：</span>
            {memory.issues.join("；")}
          </div>
        )}
      </div>
    </section>
  );
}
