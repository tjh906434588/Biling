/**
 * @file writing/chapter-content.tsx
 * 写作页右侧「当前章节正文」面板：章节标题（点击复制）+ 版本标识/版本树浮层 + 定稿/草稿徽标 +
 * 字数/保存状态/签约警示 + 就地编辑 textarea，以及三种空态（无详情/未生成/未选中章）。
 * 纯展示组件：正文编辑内容、保存状态、版本选中与回调全部由 writing-panel 传入，
 * 组件内不持有任何 state（版本树浮层显隐也由父组件控制）。
 */
"use client";

import { copyText } from "@/utils/clipboard";
import type { ChapterDetail, ChapterVersion } from "@/lib/api";
import { VersionTree } from "./version-tree";
import type { ShowToast } from "./panel-utils";

/** 正文区展示 props：数据与回调全部由 writing-panel 传入，不做状态编排。 */
interface ChapterContentProps {
  detail: ChapterDetail | null;
  activeNo: number | null;
  selectedVersion: ChapterVersion | null;
  selectedIsFinal: boolean;
  editText: string;
  onEditText: (v: string) => void;
  saveState: "saved" | "dirty" | "saving";
  versionOpen: boolean;
  /** 版本标识按钮：切换浮层开合。 */
  onToggleVersionOpen: () => void;
  /** 遮罩点击 / 版本树选择：关闭浮层。 */
  onCloseVersionOpen: () => void;
  aiBusy: boolean;
  /** 点击版本树节点：父组件负责切换预览选中（并关闭浮层）。 */
  onSelectVersion: (id: string) => void;
  showToast: ShowToast;
}

/** 当前章节正文面板（含版本树浮层与就地编辑）。 */
export function ChapterContent({
  detail,
  activeNo,
  selectedVersion,
  selectedIsFinal,
  editText,
  onEditText,
  saveState,
  versionOpen,
  onToggleVersionOpen,
  onCloseVersionOpen,
  aiBusy,
  onSelectVersion,
  showToast,
}: ChapterContentProps) {
  return (
    <>
      {detail ? (
        <div className="panel flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="panel-head">
            <h3 className="panel-title">
              {/* 点击标题即复制「第 X 章 标题」（含章节号），无需单独按钮 */}
              <span
                title="点击复制章节标题"
                className="cursor-pointer select-text"
                onClick={() => {
                  const t = (selectedVersion?.title ?? detail.title)?.trim();
                  if (!t) {
                    showToast("该章暂无标题，无法复制。", "warning");
                    return;
                  }
                  void copyText(t)
                    .then(() => showToast("已复制章节标题", "success"))
                    .catch(() => showToast("复制失败，请手动选中标题复制。", "error"));
                }}
              >
                第 {detail.chapter_no} 章
                {(selectedVersion?.title ?? detail.title) ? ` ${selectedVersion?.title ?? detail.title}` : ""}
              </span>
              {/* 标题旁版本标识：v{n}，点击展开内联版本树（新增/重新生成=根，评价优化=子级） */}
              <span className="relative inline-flex">
                <button
                  type="button"
                  onClick={onToggleVersionOpen}
                  className="ml-1 inline-flex cursor-pointer items-baseline rounded-md px-1.5 py-0.5 align-middle transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  title="点击查看这一章的所有版本，可点击切换预览"
                >
                  {selectedVersion ? (
                    <span className="text-xs font-semibold tabular-nums text-zinc-600 dark:text-zinc-300">
                      第{selectedVersion.version_no}版
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">第?版</span>
                  )}
                </button>
                {versionOpen && detail && (
                  <>
                    {/* 透明点击捕获层：点浮层外部即关闭（非模态，不遮罩正文） */}
                    <div
                      className="fixed inset-0 z-40"
                      aria-hidden
                      onClick={onCloseVersionOpen}
                    />
                    <div className="absolute left-0 top-full z-50 mt-2 max-h-[60vh] w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-surface p-2 shadow-book dark:border-zinc-700 dark:bg-zinc-900">
                      <p className="px-2 py-1 text-[11px] leading-5 text-zinc-400">
                        点开是这一章的版本列表，每次生成或重写都会新增一版；按评价优化出的新版会排在被优化那版的下面，可以一直改下去。点节点切换预览。
                      </p>
                      {detail.versions.length > 0 ? (
                        <VersionTree
                          versions={detail.versions}
                          selectedId={selectedVersion?.id ?? null}
                          aiBusy={aiBusy}
                          onSelect={(id) => {
                            onSelectVersion(id);
                            onCloseVersionOpen();
                          }}
                        />
                      ) : (
                        <p className="py-4 text-center text-xs text-zinc-400">这章还没有生成过正文。</p>
                      )}
                    </div>
                  </>
                )}
              </span>
              <span className="ml-1 text-xs font-normal text-zinc-500">
                {selectedIsFinal ? "已定稿" : "草稿"}
              </span>
              {/* 当前章节版本字数：跟随正文实时统计（含就地编辑中的内容） */}
              {selectedVersion != null && (
                <span className="ml-1.5 text-xs font-normal tabular-nums text-zinc-500">
                  · {editText.length} 字
                </span>
              )}
              {/* 就地编辑保存状态（无改动时不显示；有未保存改动提醒作者，防抖 2s 自动落盘） */}
              {selectedVersion && saveState !== "saved" && (
                <span className="ml-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  {saveState === "saving" ? "保存中…" : "已修改"}
                </span>
              )}
              {/* 选中版本签约未过签：红色警示，提示需按评价修正或强制定稿 */}
              {selectedVersion?.signing_blocked && (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded-md bg-red-600/10 px-1.5 py-0.5 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-600/30 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/30">
                  有红线问题 · 定稿需二次确认
                </span>
              )}
            </h3>
          </div>
          {selectedVersion ? (
            <textarea
              value={editText}
              onChange={(e) => onEditText(e.target.value)}
              spellCheck={false}
              aria-label="本章正文（可直接编辑，停止输入后自动保存）"
              placeholder="直接在正文上修改，停止输入后自动保存；修改后右侧「评价与优化」会出现「重新评价」按钮。"
              className="reading w-full flex-1 min-h-0 resize-none overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-5 outline-none focus:border-primary dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          ) : (
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
              本章还没有已选定的正文版本。
            </p>
          )}
        </div>
      ) : activeNo != null ? (
        <div className="panel flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="panel-head">
            <h3 className="panel-title">
              第 {activeNo} 章
            </h3>
          </div>
          <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
            第 {activeNo} 章正文还没生成，或暂时没读到，请稍后重试。
          </p>
        </div>
      ) : (
        <div className="panel flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="panel-head">
            <h3 className="panel-title">
              本章正文
            </h3>
          </div>
          <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
            在左侧章节目录选一章查看正文，或点「新增章节」写新的一章。
          </p>
        </div>
      )}
    </>
  );
}
