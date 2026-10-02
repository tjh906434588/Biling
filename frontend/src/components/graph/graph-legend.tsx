/**
 * @file graph/graph-legend.tsx
 * 人物关系图图例（纯展示，由 graph-panel.tsx 拆出）：
 * 标题「?」悬浮说明身份字含义（主/重/次/灰/势），色块取各分级配色。
 */
"use client";

import { KIND_STYLE, ROLE_STYLE } from "./graph-utils";

/** 图例：悬浮提示关系图说明与身份字含义。 */
export function GraphLegend() {
  return (
    <span className="group relative inline-flex items-center">
      <span
        aria-label="人物关系图说明"
        className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-zinc-300 text-[10px] font-semibold text-zinc-400 hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-zinc-500 dark:hover:text-zinc-300"
      >
        ?
      </span>
      <span className="invisible absolute left-0 top-full z-30 mt-1.5 w-80 rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-relaxed text-zinc-700 opacity-0 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
        <p>
          每章写完后自动整理人物关系。两人之间多条关系会合并显示，鼠标放到线上可看详情；过时的关系自动隐藏。
        </p>
        <div className="mt-2.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <p className="mb-1.5 font-medium text-zinc-800 dark:text-zinc-100">圆点上的身份字</p>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {(
              [
                ["主", "主角", "protagonist"],
                ["重", "重要配角", "major"],
                ["次", "次要配角", "minor"],
                ["灰", "龙套/炮灰", "extra"],
                ["势", "势力", "faction"],
              ] as [string, string, string][]
            ).map(([mark, name, key]) => {
              const s = (ROLE_STYLE as Record<string, { fill: string; stroke: string; text: string }>)[key] ?? KIND_STYLE[key];
              return (
              <li key={mark} className="flex items-center gap-1.5">
                <span
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none"
                  style={{ background: s.fill, color: s.text, border: `1px solid ${s.stroke}` }}
                >
                  {mark}
                </span>
                {name}
              </li>
              );
            })}
          </ul>
        </div>
      </span>
    </span>
  );
}
