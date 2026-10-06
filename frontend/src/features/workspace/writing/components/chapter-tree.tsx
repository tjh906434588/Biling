/**
 * @file writing/chapter-tree.tsx
 * 写作页左侧章节目录栏：章节目录（按卷分组/搜索/折叠/高亮，与大纲页一致）+ 本章操作
 * （定稿 / 重新生成正文 / 提取入记忆层 / 复制正文）。纯展示组件：数据与回调全部由 props
 * 传入，状态编排留在 writing-panel.tsx。同时导出章节按卷归组纯函数 groupChaptersByVolume
 * 与版本来源友好标签 sourceLabel（写作页其他位置共用）。
 */
"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { DEFAULT_VOLUME, type VolumeInfo } from "@/constants";
import { sourceLabel } from "./source-label";

export { sourceLabel } from "./source-label";
import type { ChapterListItem, ChapterVersion } from "@/lib/api";
import { CostHint } from "@/lib/ai-status";
import InfoTip from "@/components/info-tip";

export interface ChapterVolumeGroup {
  key: string;
  no: number | undefined;
  title: string;
  label: string;
  items: ChapterListItem[];
}

function cleanVolumeTitle(name: string | undefined): string {
  const n = (name ?? "")
    .replace(/【[^】]*】/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .trim();
  return n.replace(/^第\s*[一二三四五六七八九十百千万零〇\d]+\s*卷\s*[:：、.。\-—\s]*/, "").trim();
}

/** 章节列表标题：超长时省略号截断 + 悬浮显示完整标题；未超长不显示悬浮效果。 */
function EllipsisTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflow(el.scrollWidth > el.clientWidth);
  }, [text]);
  return (
    <span ref={ref} className="min-w-0 truncate text-sm font-medium" title={overflow ? text : undefined}>
      {text}
    </span>
  );
}

/** 把章节按当前生效蓝图的 volumes（chapters_range）归组；不在任何卷内的归「未分卷/全部章节」。
 *  与大纲页 groupByVolume 逻辑一致，只是 item 换成 ChapterListItem。 */
export function groupChaptersByVolume(
  chapters: ChapterListItem[],
  volumes: VolumeInfo[] | undefined,
): ChapterVolumeGroup[] {
  const vols = volumes ?? [];
  const parsed = vols
    .map((v) => {
      const m = v.chapters_range?.match(/(\d+)\s*[-~至到]\s*(\d+)/);
      return { v, start: m ? Number(m[1]) : NaN, end: m ? Number(m[2]) : NaN };
    })
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end));

  // 无卷或全部卷范围解析失败 → 用一个默认「第1卷」吸收全部章节
  const effectiveVols = parsed.length > 0 ? vols : [DEFAULT_VOLUME];
  const effectiveParsed =
    parsed.length > 0 ? parsed : [{ v: DEFAULT_VOLUME, start: 1, end: Number.MAX_SAFE_INTEGER }];

  const groups: ChapterVolumeGroup[] = effectiveVols.map((v) => {
    const title = cleanVolumeTitle(v.name);
    const label = v.no != null ? `第${v.no}卷${title ? ` ${title}` : ""}` : title || "卷";
    return {
      key: `vol-${v.no ?? v.name ?? "?"}`,
      no: v.no,
      title,
      label,
      items: [],
    };
  });
  const rest: ChapterVolumeGroup = {
    key: "rest",
    no: undefined,
    title: "未分卷",
    label: "未分卷",
    items: [],
  };

  for (const c of [...chapters].sort((a, b) => a.chapter_no - b.chapter_no)) {
    const hit = effectiveParsed.find(({ start, end }) => c.chapter_no >= start && c.chapter_no <= end);
    const target = hit
      ? groups.find((g) => g.key === `vol-${hit.v.no ?? hit.v.name ?? "?"}`)
      : undefined;
    (target ?? rest).items.push(c);
  }

  const result = groups.filter((g) => g.items.length > 0);
  if (rest.items.length > 0) result.push(rest);
  return result;
}

/** 章节目录侧栏的 props：数据 + 回调全部由 writing-panel 传入，组件内不做任何状态编排。 */
interface ChapterSidebarProps {
  chapters: ChapterListItem[];
  volumes: VolumeInfo[];
  chapterSearch: string;
  onChapterSearch: (v: string) => void;
  /** 被折叠的卷 key（默认全展开；搜索时强制展开匹配卷）。 */
  collapsedVols: Record<string, boolean>;
  /** 折叠/展开某卷（组件内已按搜索态拦截，搜索时不可折叠）。 */
  onToggleVol: (key: string) => void;
  activeNo: number | null;
  activeChapter: ChapterListItem | null;
  /** 当前预览选中版本标题（目录标题联动：激活章未定稿时跟随选中版本标题）。 */
  activeVersionTitle: string | null | undefined;
  /** AI 占用中（评价/提取）：目录与版本切换禁点、操作按钮禁用。 */
  aiBusy: boolean;
  reviewing: boolean;
  generating: boolean;
  /** 当前生成是「新增章节」还是「重新生成正文」：决定新增/重新生成按钮的禁用与提示。 */
  genIsRegenerate: boolean;
  /** 顶部悬浮提示（全局 Message 别名）。 */
  showToast: (msg: string, level?: "success" | "warning" | "error") => void;
  /** 打开「新增章节」弹窗。 */
  onAdd: () => void;
  /** 点击目录某章：切激活章并加载详情（含评价/版本选中态重置）。 */
  onSelectChapter: (no: number) => void;
  /** 打开「重写正文」弹窗，由用户选择人工重写或 AI 重新生成。 */
  onRewrite: () => void;
  onExpand: () => void;
  /** 当前 AI 版本上有未确认的临时修改 → 显示「存为新版本」按钮（确认式版本化入口）。 */
  hasVersionEdits: boolean;
  /** 把当前临时修改真正保存为一个新的人工版本（原版本保留不变）。 */
  onSaveAsNewVersion: () => void;
  /** 「格式化排版」可用性：已选中版本且正文非空。 */
  canFormat: boolean;
  /** 纯文本排版格式化（首行缩进/段落空行，不调 AI、不改文字）。 */
  onFormat: () => void;
  /** 当前预览选中的正文版本（null=未选中）。 */
  selectedVersion: ChapterVersion | null;
  /** 选中版本是否已定稿（激活）：决定「定稿」/「提取」按钮可用性。 */
  selectedIsFinal: boolean;
  /** 选中版本（已定稿）还没提取过记忆层 → 高亮「提取→记忆层」。 */
  extractPending: boolean;
  /** 当前预览正文是否基于旧大纲生成：只能看，不能评价/修订/提取。 */
  isStaleForActiveOutline: boolean;
  extracting: boolean;
  /** 顶部「定稿」：先落盘草稿区未保存编辑并弹二次确认。 */
  onFinalize: () => void;
  /** 提取当前选中已定稿版本入记忆层（含前置校验与二次确认）。 */
  onExtract: () => void;
  /** 复制当前选中版本正文到剪贴板。 */
  onCopy: () => void;
  /** 查看当前章已填写的信息控制（谁知道了什么）。 */
  onViewInfo: () => void;
}

/** 写作页左侧栏：章节目录（按卷分组、可展开搜索）+ 本章操作。 */
export function ChapterSidebar({
  chapters,
  volumes,
  chapterSearch,
  onChapterSearch,
  collapsedVols,
  onToggleVol,
  activeNo,
  activeChapter,
  activeVersionTitle,
  aiBusy,
  reviewing,
  generating,
  genIsRegenerate,
  showToast,
  onAdd,
  onSelectChapter,
  onRewrite,
  onExpand,
  hasVersionEdits,
  onSaveAsNewVersion,
  canFormat,
  onFormat,
  selectedVersion,
  selectedIsFinal,
  extractPending,
  isStaleForActiveOutline,
  extracting,
  onFinalize,
  onExtract,
  onCopy,
  onViewInfo,
}: ChapterSidebarProps) {
  /** 提取按钮问号弹层是否打开：打开期间按钮自身 title 不显示，避免两套提示重叠 */
  const [tipOpen, setTipOpen] = useState(false);
  /** 章节目录按卷分组（搜索为空时按卷归组；搜索时仅过滤、不折叠）。 */
  const volGroups = groupChaptersByVolume(chapters, volumes);
  const chapterQ = chapterSearch.trim().toLowerCase();
  const chapterMatches = (c: ChapterListItem) =>
    !chapterQ || `第${c.chapter_no}章 ${c.title ?? ""}`.toLowerCase().includes(chapterQ);
  /** 目录项显示标题：当前激活章未定稿时跟随选中版本标题（版本切换本地预览联动目录），其余用章级标题。
   *  已定稿章节 c.title 已由定稿动作同步为激活版本标题，无需特判。 */
  const listItemTitle = (c: ChapterListItem) =>
    c.chapter_no === activeNo && c.status !== "complete" && activeVersionTitle
      ? activeVersionTitle
      : c.title;

  return (
    <>
      {/* 左侧：章节目录（一件事一张卡，按卷分组、可展开搜索，与大纲页一致）。
          模块高度跟随内容，最多与页面底部对齐；内容多时在列表内滚动，避免整页滚动条。 */}
      <aside className="panel-fit gap-4">
        <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="panel-head shrink-0">
            <h3 className="panel-title">章节目录</h3>
            <div className="flex items-center gap-2">
              <span className="panel-hint">{chapters.length} 章</span>
              <button
                type="button"
                onClick={() => {
                  // 生成中再次点击 = 重开弹窗查看生成进度：跳过「最新章须已定稿」门禁
                  if (!generating) {
                    // 最新一章尚未定稿 → 拦截：必须先定稿才能新增章节（空小说除外）
                    const latest = [...chapters].sort((a, b) => b.chapter_no - a.chapter_no)[0];
                    if (latest && latest.status !== "complete") {
                      showToast(`最新一章（第 ${latest.chapter_no} 章）还是草稿，请先定稿后再新增章节。`, "warning");
                      return;
                    }
                    if (latest && latest.extracted_version_id == null) {
                      showToast(`最新一章（第 ${latest.chapter_no} 章）尚未提取记忆，请先提取后再新增章节。`, "warning");
                      return;
                    }
                  }
                  onAdd();
                }}
                // 新增章节生成中不禁用：可再次点击重开弹窗查看「查看生成过程」进度（弹窗内「生成正文」仍禁用防重复）；
                // 仅「重新生成正文」生成中禁用新增（本次是重生成，进度只能从重生成入口重开查看）；
                // 评价 / 提取进行中禁用（本次操作锁定面板，等完成才解除）
                disabled={(generating && genIsRegenerate) || aiBusy}
                title={
                  aiBusy
                    ? reviewing
                      ? "评价进行中，暂不能新增章节"
                      : "正在记进 AI 记忆中，暂不能新增章节"
                    : generating && genIsRegenerate
                      ? "重新生成正文中，暂不能新增章节"
                      : generating
                        ? "正文生成中，点击可再次打开弹窗查看进度"
                        : undefined
                }
                className="btn btn-primary px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                新增章节
              </button>
            </div>
          </div>
          {chapters.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有章节。点右上角「新增章节」，写下一章。
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <input
                className="mb-3 w-full shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                placeholder="搜索章节（章号 / 标题）"
                value={chapterSearch}
                onChange={(e) => onChapterSearch(e.target.value)}
              />
              <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                {volGroups
                  .map((g) => {
                    const items = chapterQ ? g.items.filter(chapterMatches) : g.items;
                    return items.length > 0 ? { g, items } : null;
                  })
                  .filter((x): x is { g: ChapterVolumeGroup; items: ChapterListItem[] } => x != null)
                  .map(({ g, items }, idx, arr) => {
                    const isCollapsed = !chapterQ && collapsedVols[g.key];
                    const isLast = idx === arr.length - 1;
                    return (
                      <section key={g.key} className={isLast ? "" : "mb-2"}>
                        <button
                          type="button"
                          onClick={() => !chapterQ && onToggleVol(g.key)}
                          className={`mb-1.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                            chapterQ
                              ? "cursor-default"
                              : "cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                          }`}
                          title={chapterQ ? undefined : isCollapsed ? "展开本卷章节" : "收起本卷章节"}
                        >
                          <span
                            className={`shrink-0 text-[10px] leading-none text-zinc-400 transition-transform ${
                              isCollapsed ? "-rotate-90" : ""
                            }`}
                          >
                            ▾
                          </span>
                          <h4 className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                            {g.no != null && <span className="shrink-0">第{g.no}卷</span>}
                            {g.title && <span className={g.no != null ? "ml-1" : ""}>{g.title}</span>}
                          </h4>
                          <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{items.length} 章</span>
                        </button>
                        {!isCollapsed && (
                          <ul className="mb-1.5 ml-2 flex flex-col gap-2 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                            {items.map((c) => (
                              <li key={c.id}>
                                <button
                                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                                    activeNo === c.chapter_no
                                      ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
                                      : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                                  } ${aiBusy ? "cursor-not-allowed opacity-60" : ""}`}
                                  disabled={aiBusy}
                                  title={aiBusy ? "AI 处理中，暂不能切换章节" : undefined}
                                  onClick={() => {
                                    // 章节目录不允许取消选中：点击任意章节（含已选中）都保持/设为选中
                                    onSelectChapter(c.chapter_no);
                                  }}
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    <EllipsisTitle text={`第${c.chapter_no}章${listItemTitle(c) ? ` ${listItemTitle(c)}` : ""}`} />
                                    {c.active_source && (
                                      <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
                                        {sourceLabel(c.active_source)}
                                      </span>
                                    )}
                                    {c.status === "complete" && (
                                      <span className="shrink-0 rounded bg-green-100 px-1 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
                                        已定稿
                                      </span>
                                    )}
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
            </div>
          )}
        </div>

        {/* 本章操作只在选中章节后显示。 */}
        {activeNo != null && (
        <div className="panel shrink-0">
          <div className="panel-head">
            <h3 className="panel-title">本章操作</h3>
            {activeNo != null && (
              <span className="panel-hint">
                第 {activeNo} 章{activeChapter?.title ? ` ${activeChapter.title}` : ""}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {/* 存为新版本：AI 版本上有未确认的临时修改时才显示（确认式版本化入口）；
                点击才把修改真正保存为一个新的人工版本，避免改一点就多一个版本 */}
            {hasVersionEdits && (
              <button
                type="button"
                onClick={onSaveAsNewVersion}
                disabled={activeNo == null || aiBusy || !selectedVersion}
                className="btn btn-primary col-span-2 w-full"
                title="把当前修改保存为一个新的人工版本，原版本保留不变"
              >
                存为新版本
              </button>
            )}
            {/* 重写正文：统一人工重写与 AI 重新生成入口，在抽屉内选择方式。 */}
            <button
              type="button"
              onClick={onRewrite}
              disabled={activeNo == null || aiBusy || !selectedVersion}
              className="btn btn-ghost w-full"
              title="重新写一版正文，可在抽屉中选择人工重写或 AI 重新生成"
            >
              重写正文
            </button>
            {/* AI 扩写：仅人工版本且正文非空时展示（AI 生成内容可直接评价优化派生，不走扩写） */}
            {selectedVersion?.source === "user_edit" && !!selectedVersion.content.trim() && (
              <button
                type="button"
                onClick={onExpand}
                disabled={activeNo == null || aiBusy}
                className="btn btn-ghost w-full"
                title="基于当前人工版本正文调用 AI 扩写，生成一个 AI 子版本"
              >
                AI 扩写
              </button>
            )}
            {/* 格式化排版：仅人工版本展示（AI 生成内容自带规范排版，无需格式化）；
                纯文本整理（首行缩进/段落空行），不调 AI、不改文字内容 */}
            {selectedVersion?.source === "user_edit" && (
              <button
                type="button"
                onClick={onFormat}
                disabled={activeNo == null || aiBusy || !canFormat}
                className="btn btn-ghost w-full"
                title="把正文整理成 AI 生成稿的排版：每段首行缩进两格、段落之间空一行（不改文字内容）"
              >
                格式化排版
              </button>
            )}
            {/* 定稿：把当前选中的草稿版本定稿激活（同一时间只能定稿一个版本）；选中已定稿版本时隐藏 */}
            {!selectedIsFinal && (
              <button
                type="button"
                onClick={() => void onFinalize()}
                disabled={activeNo == null || generating || aiBusy || !selectedVersion}
                className="btn btn-primary w-full"
                title={
                  activeNo == null || !selectedVersion
                    ? "请先选择一章"
                    : aiBusy
                      ? reviewing
                        ? "评价进行中，暂不能定稿"
                        : "正在记进 AI 记忆中，暂不能定稿"
                      : selectedVersion.signing_blocked
                        ? "这一版有红线或抄袭风险，定稿需要二次确认"
                        : "将当前选中的草稿版本定稿为本章正文"
                }
              >
                定稿
              </button>
            )}
            {/* 评价入口统一在右侧「评价与优化」，本章操作只保留提取与复制 */}
            <button
              className={`relative w-full cursor-pointer rounded-lg border py-2 pl-3 pr-7 text-sm transition-colors ${
                extractPending
                  ? "border-blue-500 bg-gradient-to-r from-blue-200 to-blue-50 font-medium text-blue-800 hover:border-blue-600 hover:from-blue-300 hover:to-blue-100 dark:border-blue-500 dark:from-blue-800/80 dark:to-blue-950/60 dark:text-blue-300 dark:hover:border-blue-400 dark:hover:from-blue-800 dark:hover:to-blue-900/70 disabled:hover:border-blue-500 dark:disabled:hover:border-blue-500"
                  : "border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 disabled:hover:border-zinc-300 dark:disabled:hover:border-zinc-700"
              } disabled:cursor-not-allowed disabled:opacity-100`}
              onClick={onExtract}
              disabled={activeNo == null || extracting || reviewing || !selectedVersion || !selectedIsFinal}
              title={
                tipOpen
                  ? undefined // 问号弹层已打开：按钮自身 title 隐藏，避免两套提示重叠
                  : activeNo == null
                    ? "请先在章节目录选择一章"
                    : isStaleForActiveOutline
                      ? "当前正文基于旧版大纲生成，只能查看；请基于当前正在用的大纲重新生成正文并定稿后再记进 AI 记忆"
                    : reviewing
                      ? "评价进行中，暂不能记进 AI 记忆"
                      : !selectedVersion
                        ? "先选定版本再记进 AI 记忆"
                        : !selectedIsFinal
                          ? "只有已定稿的正文才能记进 AI 记忆，请先在「本章操作」点「定稿」"
                          : extractPending
                            ? "这版正文还没记进 AI 记忆，点一下「记进 AI 记忆」就好（或已切到新版本）"
                            : "把本章摘要/角色状态/伏笔写进 AI 记忆"
              }
            >
              {extracting ? "正在记进…" : "记进 AI 记忆"}
              <span
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={(e) => e.stopPropagation()}
              >
                <InfoTip side="right" onOpenChange={setTipOpen}>
                  <p className="font-medium text-zinc-700 dark:text-zinc-200">提取本章 = 给 AI 记账。</p>
                  把这一章的摘要、角色当前状态、新埋的伏笔等写进 AI 记忆。
                  下一章生成时 AI 写作会自动读到，角色性格的变化也靠它跟踪。
                  <span className="mt-1.5 block text-zinc-400">
                    每写完一章记得点一下，不然下一章可能「忘了」刚才发生了什么。
                  </span>
                </InfoTip>
              </span>
            </button>
            {/* 信息控制：仅选中章节时显示；查看本章已填写的信息控制（谁知道了什么），修改需重新生成时调整 */}
            {activeNo != null && selectedVersion?.source !== "user_edit" && (
              <button
                type="button"
                onClick={onViewInfo}
                className="btn btn-ghost w-full"
                title="查看本章已填写的信息控制（正文可不体现，但绝不能与它们冲突）"
              >
                信息控制
              </button>
            )}
            <button
              type="button"
              onClick={onCopy}
              disabled={activeNo == null || !selectedVersion}
              className="btn btn-ghost w-full"
            >
             复制本章正文
            </button>
            <div className="col-span-2 mt-1 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
              <CostHint />
            </div>
          </div>
        </div>
        )}
      </aside>
    </>
  );
}
