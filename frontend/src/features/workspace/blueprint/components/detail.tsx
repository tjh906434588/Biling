/**
 * @file blueprint/detail.tsx
 * 蓝图详情区（右侧主区，纯展示 + 回调）：空态提示 / 详情面板（版本标题 + 生效徽章 +
 * 操作按钮（设为当前使用/删除/正在使用提示）+ 内容各区块）。
 * 由 blueprint-panel.tsx 按 JSX 区块拆分——激活中禁用态、激活/删除回调均由 props 传入；
 * 内容区块 BlueprintContent 仅按 content 渲染，不含任何状态与回调。
 */
"use client";

import type { Blueprint } from "@/lib/api";
import { StatusBadge } from "./status-badge";

/** 蓝图详情区：空态 / 详情面板（头部操作 + 内容滚动区）。 */
export function BlueprintDetail({
  selected,
  activatingId,
  onActivate,
  onDelete,
}: {
  selected: Blueprint | null;
  /** 正在后台激活的蓝图 id：非空时操作按钮禁用（切换中不允许重复操作）。 */
  activatingId: string | null;
  onActivate: (b: Blueprint) => void;
  onDelete: (b: Blueprint) => void;
}) {
  if (!selected) {
    return (
      <div className="panel flex min-h-0 flex-col gap-3">
        <div className="panel-head mb-0">
          <h3 className="panel-title">蓝图详情</h3>
        </div>
        <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
          还没有蓝图。点左侧「新增蓝图」，让 AI 帮你整理全书方案（规则/人物弧/分卷/伏笔计划）。
        </p>
      </div>
    );
  }
  const c = selected.content;
  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <h3 className="panel-title">
          蓝图 v{selected.version} {c?.title ?? ""}
          <StatusBadge status={selected.status} />
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {selected.status !== "active" && (
            <button
              className="btn btn-approve"
              onClick={() => onActivate(selected)}
              disabled={activatingId !== null}
            >
              {activatingId !== null ? "正在切换…" : "设为当前使用"}
            </button>
          )}
          {selected.status !== "active" && (
            <button
              className="btn btn-danger"
              onClick={() => onDelete(selected)}
              disabled={activatingId !== null}
            >
              删除
            </button>
          )}
          {selected.status === "active" && (
            <span className="rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
              当前正在使用 · 不可删除，想删需先切换到另一版
            </span>
          )}
        </div>
      </div>

      <BlueprintContent content={c} />
    </div>
  );
}

/** 蓝图内容各区块（纯展示）：一句话/主题/核心冲突/体量规划/世界规则/人物弧光/分卷/伏笔计划/长线支线/保留要点。 */
function BlueprintContent({ content: c }: { content: Blueprint["content"] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {c?.logline && (
        <p className="mb-2 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
          <span className="font-semibold">一句话：</span>
          {c.logline}
        </p>
      )}
      {c?.theme && (
        <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">
          <span className="font-semibold">主题：</span>
          {c.theme}
        </p>
      )}
      {c?.core_conflict && (
        <p className="mb-3 text-sm text-zinc-700 dark:text-zinc-300">
          <span className="font-semibold">核心冲突：</span>
          {c.core_conflict}
        </p>
      )}

      {(c?.total_word_count || c?.total_chapters || c?.chapter_word_count) && (
        <p className="mb-3 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-900">
          <span className="font-semibold">全书体量规划：</span>
          {c.total_word_count ? `总字数 ${c.total_word_count}` : ""}
          {c.total_word_count && c.total_chapters ? " · " : ""}
          {c.total_chapters ? `总章数 ${c.total_chapters}` : ""}
          {(c.total_word_count || c.total_chapters) && c.chapter_word_count ? " · " : ""}
          {c.chapter_word_count ? `单章 ${c.chapter_word_count}` : ""}
        </p>
      )}

      {c?.world_rules && c.world_rules.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">世界规则</h4>
          <ul className="flex flex-col gap-1">
            {c.world_rules.map((r, i) => (
              <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-medium">{r.name}</span>：{r.detail}
                {r.constraints?.length ? (
                  <span className="ml-2 text-[11px] text-red-500 dark:text-red-400">约束：{r.constraints.join("；")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c?.character_arcs && c.character_arcs.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">人物弧光</h4>
          <ul className="flex flex-col gap-1">
            {c.character_arcs.map((a, i) => (
              <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-medium">{a.character}</span>
                {a.personality ? <span className="ml-1.5 text-[11px] text-zinc-500">性格：{a.personality}</span> : null}
                ：{a.start} → {a.end}
                {a.turning_points?.length ? (
                  <span className="ml-2 text-[11px] text-zinc-500">转折：{a.turning_points.join("；")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c?.volumes && c.volumes.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">分卷</h4>
          <div className="flex flex-wrap gap-1.5">
            {c.volumes.map((v, i) => (
              <span key={i} className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs dark:border-zinc-800">
                第{v.no}卷《{v.name}》{v.focus}
                {v.word_count ? <span className="ml-1 text-[11px] text-zinc-400">（{v.word_count}）</span> : null}
                （{v.chapters_range}）
              </span>
            ))}
          </div>
        </div>
      )}

      {c?.foreshadowing_plan && c.foreshadowing_plan.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">伏笔计划</h4>
          <ul className="flex flex-col gap-1">
            {c.foreshadowing_plan.map((f, i) => (
              <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                第{f.plant_chapter}章埋 → 第{f.payoff_chapter}章揭：{f.desc}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c?.subplots && c.subplots.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">长线支线</h4>
          <ul className="flex flex-col gap-1">
            {c.subplots.map((s, i) => (
              <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c?.notes && c.notes.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">保留要点（原文）</h4>
          <ul className="flex flex-col gap-1">
            {c.notes.map((n, i) => (
              <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
