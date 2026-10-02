/**
 * @file components/outline/outline-list.tsx
 * 大纲页左侧「章节大纲」卷分组列表（展示型子组件，由 outline-panel.tsx 拆分）：
 * 头部计数 + 新增大纲按钮、搜索框、按卷分组的章节列表（可折叠 / 选中高亮 / 已批准徽标）。
 * 不持有任何 state：数据与回调全部经 props 传入，搜索过滤由父组件算好以 groups 传入。
 */
"use client";

import type { Outline } from "@/lib/api";
import type { VolumeGroup } from "./outline-utils";

interface Props {
  /** 大纲总条数（头部「N 条」）。 */
  total: number;
  /** 已按搜索词过滤后的卷分组（只保留命中组；空搜索即全量）。 */
  groups: Array<{ g: VolumeGroup; items: Outline[] }>;
  /** 搜索框原始输入值。 */
  outlineSearch: string;
  /** 搜索词（trim + 小写后）；非空 = 搜索中，折叠交互与箭头样式随之变化。 */
  outlineQ: string;
  /** 被折叠的卷 key（默认全展开）。搜索时强制展开匹配卷（与写作页章节目录一致）。 */
  collapsedKeys: Record<string, boolean>;
  /** 当前选中章的大纲 id。 */
  selectedId: string | null;
  /** 重写生成中：禁用「新增大纲」入口（生成中的入口互斥）。 */
  generatingRewrite: boolean;
  onSearchChange: (v: string) => void;
  onToggleCollapse: (key: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

export default function OutlineList({
  total,
  groups,
  outlineSearch,
  outlineQ,
  collapsedKeys,
  selectedId,
  generatingRewrite,
  onSearchChange,
  onToggleCollapse,
  onSelect,
  onAdd,
}: Props) {
  return (
    <aside className="flex max-h-[calc(100dvh-6rem)] min-w-0 flex-col gap-4 overflow-hidden">
      <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="panel-head shrink-0">
          <h3 className="panel-title">章节大纲</h3>
          <div className="flex items-center gap-2">
            <span className="panel-hint">{total} 条</span>
            <button
              type="button"
              onClick={onAdd}
              disabled={generatingRewrite}
              title={generatingRewrite ? "大纲生成中，暂不能新增大纲" : undefined}
              className="btn btn-primary px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              新增大纲
            </button>
          </div>
        </div>
        {total === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
            还没有大纲。点右上角「新增大纲」，让 AI 排出第一章大纲。
          </p>
        ) : (
          <>
            <input
              className="mb-3 w-full shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder="搜索大纲（章号 / 标题）"
              value={outlineSearch}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              {groups.map(({ g, items }, idx, arr) => {
                const collapsed = !outlineQ && collapsedKeys[g.key];
                const isLast = idx === arr.length - 1;
                return (
                  <section key={g.key} className={isLast ? "" : "mb-2"}>
                    <button
                      type="button"
                      onClick={() => !outlineQ && onToggleCollapse(g.key)}
                      title={collapsed ? "展开该卷章节" : "收起该卷章节"}
                      className={`mb-1.5 flex w-full items-start gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors ${
                        outlineQ
                          ? "cursor-default"
                          : "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                      }`}
                    >
                      <span
                        className={`mt-0.5 shrink-0 text-[10px] text-zinc-400 transition-transform ${
                          collapsed ? "-rotate-90" : ""
                        }`}
                      >
                        ▾
                      </span>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400">{g.label}</h4>
                      </div>
                      <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{items.length} 章</span>
                    </button>
                    {!collapsed && (
                      <ul className="flex flex-col gap-2">
                        {items.map((o) => (
                          <li key={o.id}>
                            <button
                              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                                selectedId === o.id
                                  ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
                                  : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                              }`}
                              onClick={() => onSelect(o.id)}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">
                                  第{o.chapter_no}章{o.title ? ` ${o.title}` : ""}
                                </span>
                                {o.status === "approved" ? (
                                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
                                    已批准
                                  </span>
                                ) : (
                                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                                    未批准
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 line-clamp-1 text-[11px] text-zinc-500">
                                {(o.content?.goal as string | undefined) ?? ""}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
