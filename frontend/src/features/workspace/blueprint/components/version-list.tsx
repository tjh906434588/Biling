/**
 * @file blueprint/version-list.tsx
 * 蓝图版本列表（左侧栏，纯展示 + 回调）：顶部「新增蓝图」按钮 + 版本列表 / 空态提示。
 * 由 blueprint-panel.tsx 按 JSX 区块拆分——选中高亮、激活中禁用态、点选/新增回调均由 props 传入，
 * 列表选中态与「生效中」回退选中由父组件计算后经 selectedId 传入。
 */
"use client";

import type { Blueprint } from "@/lib/api";
import { StatusBadge } from "./status-badge";

/** 蓝图版本列表（左侧栏）：新增入口 + 版本项（选中高亮、生效徽章、一行梗概）。 */
export function BlueprintVersionList({
  items,
  selectedId,
  activatingId,
  onAdd,
  onSelect,
}: {
  items: Blueprint[];
  /** 当前生效的选中蓝图 id（含「默认跟随生效中/第一条」的回退选中）：决定列表项高亮。 */
  selectedId: string | null;
  /** 正在后台激活的蓝图 id：非空时「新增蓝图」按钮禁用（切换中不允许新增）。 */
  activatingId: string | null;
  onAdd: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="panel panel-fit gap-3">
      <div className="panel-head mb-0">
        <h3 className="panel-title">蓝图版本</h3>
        <button
          type="button"
          onClick={onAdd}
          disabled={activatingId !== null}
          title={activatingId !== null ? "蓝图正在切换中，完成后方可新增" : "让 AI 帮你整理一份全新的全书方案"}
          className="btn btn-primary px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          新增蓝图
        </button>
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
          还没有蓝图。点右上角「新增蓝图」，让 AI 帮你整理全书方案（规则/人物弧/分卷/伏笔计划）。
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {items.map((b) => (
            <li key={b.id}>
              <button
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  b.id === selectedId
                    ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
                    : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                }`}
                onClick={() => onSelect(b.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">v{b.version} {b.content?.title ?? ""}</span>
                  <StatusBadge status={b.status} />
                </div>
                <div className="mt-0.5 line-clamp-1 text-[11px] text-zinc-500">{b.content?.logline ?? ""}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
