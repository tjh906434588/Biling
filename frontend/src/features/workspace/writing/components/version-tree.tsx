/**
 * @file writing/version-tree.tsx
 * 版本树：章节标题旁的版本号点击展开的内联浮层内容——多级递归版本树。
 * 新增章节与重新生成正文平级、均为根节点（parent_version_id=null）；评价优化（reviser）
 * 挂在「被优化版本」之下，可沿「选中→评价→优化」无限递进。
 * 点击节点=选中预览该版本（与旧版本 tab 一致），选中后由外层关闭浮层。
 * 纯展示组件：versions / 选中 id / 禁用态与点选回调均由 props 传入。
 */
"use client";

import type { ReactNode } from "react";
import type { ChapterVersion } from "@/lib/api";
import { sourceLabel } from "./source-label";

/** 多级递归版本树（外层负责包裹浮层与透明点击捕获层）。 */
export function VersionTree({
  versions,
  selectedId,
  aiBusy,
  onSelect,
}: {
  versions: ChapterVersion[];
  /** 当前预览选中的版本 id：决定「当前」徽标与节点高亮。 */
  selectedId: string | null;
  /** AI 处理中：禁点切换版本预览。 */
  aiBusy: boolean;
  /** 点击节点：选中预览该版本（外层同时负责关闭浮层）。 */
  onSelect: (versionId: string) => void;
}) {
  const renderNodes = (parentId: string | null): ReactNode[] => {
    return versions
      .filter((v) => (parentId == null ? v.parent_version_id == null : v.parent_version_id === parentId))
      .map((v) => {
        const isSel = selectedId === v.id;
        const kids = renderNodes(v.id);
        return (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => onSelect(v.id)}
              disabled={aiBusy}
              title={
                aiBusy
                  ? "AI 处理中，暂不能切换版本预览"
                  : v.is_active
                    ? "已定稿版本（点击预览）"
                    : isSel
                      ? "当前预览的草稿版本（可在「本章操作」点「定稿」）"
                      : "点击预览此版本（草稿，可在「本章操作」定稿）"
              }
              className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                isSel
                  ? "bg-zinc-200/70 ring-1 ring-inset ring-zinc-400 dark:bg-zinc-700/70 dark:ring-zinc-500"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-700/40"
              } ${aiBusy ? "cursor-not-allowed opacity-60" : ""}`}
            >
              {/* 节点圆点：绿=已定稿，灰=草稿 */}
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  v.is_active ? "bg-green-500 dark:bg-green-400" : "bg-zinc-300 dark:bg-zinc-600"
                }`}
              />
              {/* 版本号与来源 */}
              <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">第{v.version_no}版</span>
              <span className="shrink-0 text-zinc-500 dark:text-zinc-400">· {sourceLabel(v.source)}</span>
              {/* 签约未过签标记：评价存在内容红线/抄袭类高危 issue，定稿默认被拒 */}
              {v.signing_blocked && (
                <span className="shrink-0 rounded-md bg-red-600/90 px-1.5 py-px text-[10px] font-medium text-white">
                  有红线问题
                </span>
              )}
              {/* 定稿/草稿 状态 */}
              <span
                className={`ml-auto shrink-0 font-medium ${
                  v.is_active ? "text-green-600 dark:text-green-400" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {v.is_active ? "已定稿" : "草稿"}
              </span>
              {/* 当前选中 */}
              {isSel && (
                <span className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-px text-[10px] font-medium text-white dark:bg-zinc-200 dark:text-zinc-800">
                  当前
                </span>
              )}
            </button>
            {kids.length > 0 && (
              <ul className="mt-0.5 space-y-0.5 border-l border-zinc-200 pl-3.5 dark:border-zinc-700">
                {kids}
              </ul>
            )}
          </li>
        );
      });
  };
  return <ul className="mt-1 space-y-1">{renderNodes(null)}</ul>;
}
