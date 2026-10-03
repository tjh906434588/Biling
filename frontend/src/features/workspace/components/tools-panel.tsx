/**
 * @file tools-panel.tsx
 * 工作台 tools 调试页面板（沙箱运行 AI 角色）：角色选择 + 运行参数表单 + 运行/停止 +
 * 调试产出预览（实时滚动 / 结构化结果 / 加入正式库）+ SSE 事件流日志。
 * 关键机制：纯展示组件，全部状态与数据流（agent/formValues/running/logs/result/commitItems/
 * committing/liveText/liveBoxRef）由页面主组件持有并通过 props 传入；
 * 表单值变更经 onFormChange(key, value) 回写，运行/停止/落库经回调上抛，本组件不做任何数据加载。
 */
"use client";

import type { RefObject } from "react";
import { useEffect, useState } from "react";
import { AGENTS, loadChapterFunctions } from "@/constants";
import { CostHint } from "@/lib/ai-status";
import { AGENT_KEYS, type CommitItem, type LogItem } from "./workspace-config";

export default function ToolsPanel({
  agent,
  formValues,
  running,
  logs,
  result,
  commitItems,
  committing,
  liveText,
  liveBoxRef,
  onSelectAgent,
  onFormChange,
  onRun,
  onStop,
  onCommit,
}: {
  agent: string;
  formValues: Record<string, string>;
  running: boolean;
  logs: LogItem[];
  result: string | null;
  commitItems: CommitItem[] | null;
  committing: boolean;
  liveText: string;
  liveBoxRef: RefObject<HTMLDivElement | null>;
  onSelectAgent: (key: string) => void;
  onFormChange: (key: string, value: string) => void;
  onRun: () => void;
  onStop: () => void;
  onCommit: (item: CommitItem) => void;
}) {
  /** 章节功能下拉选项（枚举字典，后端单一源；novelist 的 chapter_function select 用它，消除与字典漂移） */
  const [chapterFunctions, setChapterFunctions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    void loadChapterFunctions().then(setChapterFunctions);
  }, []);
  return (
    <div className="grid w-full gap-6 lg:grid-cols-[260px_1fr]">
      {/* 角色选择 */}
      <aside>
        <h2 className="mb-2 text-sm font-semibold text-zinc-500">选择角色</h2>
        <ul className="flex flex-col gap-2">
          {AGENT_KEYS.map((key) => (
            <li key={key}>
              <button
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  agent === key
                    ? "border-zinc-500 bg-zinc-100 dark:border-zinc-500 dark:bg-zinc-800"
                    : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                }`}
                onClick={() => onSelectAgent(key)}
              >
                <div className="text-sm font-medium">{AGENTS[key].name}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{AGENTS[key].desc}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* 参数 + 运行 */}
      <section className="flex flex-col gap-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-500">
              {AGENTS[agent].name} · 运行参数
            </h2>
            <div className="flex gap-2">
              {running ? (
                <button
                  className="btn btn-ghost border-red-300 text-red-700 hover:border-red-400 hover:text-red-800 dark:border-red-900 dark:text-red-300"
                  onClick={onStop}
                >
                  停止
                </button>
              ) : (
                <>
                  <button className="btn btn-primary px-4 py-1.5" onClick={onRun}>
                    运行
                  </button>
                  <CostHint />
                </>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
            {AGENTS[agent].params.map((p) => {
              const val = formValues[p.key] ?? "";
              return (
                <label key={p.key} className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
                    {p.label}
                    {p.optional && (
                      <span className="ml-1.5 text-[11px] font-normal text-zinc-400">
                        （可选）
                      </span>
                    )}
                  </span>
                  {p.type === "select" ? (
                    <select
                      value={String(val)}
                      onChange={(e) => onFormChange(p.key, e.target.value)}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    >
                      {p.key === "chapter_function"
                        ? (chapterFunctions.length > 0 ? chapterFunctions : [{ value: "buildup", label: "铺垫" }]).map(
                            (o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ),
                          )
                        : p.options?.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                    </select>
                  ) : p.type === "textarea" ? (
                    <textarea
                      value={String(val)}
                      placeholder={p.placeholder}
                      onChange={(e) => onFormChange(p.key, e.target.value)}
                      rows={p.key === "chapter_text" || p.key === "user_message" ? 4 : 2}
                      className="resize-y rounded-md border border-zinc-300 bg-white p-2.5 text-[13px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                  ) : p.type === "number" ? (
                    <input
                      type="number"
                      value={String(val)}
                      placeholder={p.placeholder}
                      onChange={(e) => onFormChange(p.key, e.target.value)}
                      className="w-40 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[13px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                  ) : (
                    <input
                      type="text"
                      value={String(val)}
                      placeholder={p.placeholder}
                      onChange={(e) => onFormChange(p.key, e.target.value)}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[13px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                  )}
                </label>
              );
            })}
          </div>
        </div>

        {/* 调试产出（未入库）：运行中实时滚动预览；完成后展示结构化结果 + 加入正式库 */}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-500">调试产出（未入库）</h2>
            {running ? (
              <span className="text-[11.5px] text-blue-500">
                生成中… {liveText.length} 字
              </span>
            ) : commitItems && commitItems.length > 0 ? (
              <span className="text-[11.5px] text-zinc-400">
                满意后点击「加入正式库」才会写入
              </span>
            ) : null}
          </div>
          {running && liveText && (
            <div
              ref={liveBoxRef}
              className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-blue-200 bg-blue-50 p-3 text-[13px] leading-6 text-zinc-800 dark:border-blue-900 dark:bg-blue-950 dark:text-zinc-200"
            >
              {liveText}
            </div>
          )}
          {result && (
            <>
              {commitItems && commitItems.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {commitItems.map((item) => (
                    <button
                      key={item.source ?? "single"}
                      type="button"
                      disabled={committing}
                      onClick={() => onCommit(item)}
                      className="btn btn-primary px-3 py-1.5 disabled:opacity-60"
                    >
                      {item.source
                        ? `把这版（${item.source}）加入正式库`
                        : "把这版加入正式库"}
                    </button>
                  ))}
                </div>
              )}
              <pre className="overflow-x-auto rounded-lg border border-green-200 bg-green-50 p-3 text-xs dark:border-green-900 dark:bg-green-950">
                {result}
              </pre>
            </>
          )}
          {!running && !result && (
            <p className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3 text-[12.5px] text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
              点击「运行」后，生成内容会实时滚动显示在这里；确认满意再点「加入正式库」写入。
            </p>
          )}
        </div>

        {/* 事件流 */}
        <div className="flex flex-col">
          <h2 className="mb-2 text-sm font-semibold text-zinc-500">
            SSE 事件流
            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-normal text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              context_ready → stream_delta* → schema_validate → stored
            </span>
          </h2>
          <div className="h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900">
            {logs.length === 0 ? (
              <p className="text-zinc-400">点击「运行」开始流式生成…</p>
            ) : (
              logs.map((l) => (
                <div key={l.id} className="mb-1.5 whitespace-pre-wrap break-all">
                  <span
                    className={`mr-1.5 rounded px-1 py-0.5 text-[10px] ${
                      l.kind === "ok"
                        ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                        : l.kind === "err"
                          ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                          : l.kind === "delta"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                            : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}
                  >
                    {l.event}
                  </span>
                  <span className="text-zinc-700 dark:text-zinc-300">{l.data}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
