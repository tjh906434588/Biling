/**
 * @file writing/chapter-tree.tsx
 * 写作页左侧章节目录栏：章节目录（按卷分组/搜索/折叠/高亮，与大纲页一致）+ 本章操作
 * （定稿 / 重新生成正文 / 提取入记忆层 / 复制正文）。纯展示组件：数据与回调全部由 props
 * 传入，状态编排留在 writing-panel.tsx。同时导出章节按卷归组纯函数 groupChaptersByVolume
 * 与版本来源友好标签 sourceLabel（写作页其他位置共用）。
 */
"use client";

import { DEFAULT_VOLUME, SOURCE_LABELS, type VolumeInfo } from "@/constants";
import type { ChapterListItem, ChapterVersion } from "@/lib/api";
import { CostHint } from "@/lib/ai-status";
import InfoTip from "../info-tip";

export interface ChapterVolumeGroup {
  key: string;
  label: string;
  subtitle: string;
  items: ChapterListItem[];
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

  const groups: ChapterVolumeGroup[] = effectiveVols.map((v) => ({
    key: `vol-${v.no ?? v.name ?? "?"}`,
    label: `${v.no != null ? `第${v.no}卷` : "卷"}${v.name ? ` · ${v.name}` : ""}`,
    subtitle: [v.chapters_range && `${v.chapters_range}章`, v.chapter_count, v.word_count]
      .filter(Boolean)
      .join(" · "),
    items: [],
  }));
  const rest: ChapterVolumeGroup = {
    key: "rest",
    label: "未分卷",
    subtitle: "",
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

/** 版本来源的友好标签（章节详情版本列表用）。 */
export function sourceLabel(source: string): string {
  if (source.startsWith("novelist")) return "初稿";
  return SOURCE_LABELS[source] ?? "未知来源";
}

/** 章节目录侧栏的 props：数据 + 回调全部由 writing-panel 传入，组件内不做任何状态编排。 */
interface ChapterSidebarProps {
  /** 目录折叠态：true=只显示窄条（折叠态还参与外层 grid 布局，故状态留在 writing-panel）。 */
  dirCollapsed: boolean;
  /** 设置目录折叠态（窄条↔完整目录互切）。 */
  onSetDir: (v: boolean) => void;
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
  /** 打开「重新生成正文」弹窗。 */
  onRegenerate: () => void;
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
}

/** 写作页左侧栏：章节目录（按卷分组、可展开搜索）+ 本章操作。 */
export function ChapterSidebar({
  dirCollapsed,
  onSetDir,
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
  onRegenerate,
  selectedVersion,
  selectedIsFinal,
  extractPending,
  isStaleForActiveOutline,
  extracting,
  onFinalize,
  onExtract,
  onCopy,
}: ChapterSidebarProps) {
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
      {/* 目录折叠后的窄条：点它把 340px 目录栏收起，正文与评价栏同时变宽 */}
      {dirCollapsed && (
        <div className="panel flex flex-row items-center gap-2 py-2 lg:w-full xl:h-[calc(100dvh-6rem)] xl:flex-col xl:py-3">
          <button
            type="button"
            onClick={() => onSetDir(false)}
            title="展开章节目录"
            aria-label="展开章节目录"
            className="btn btn-ghost h-8 w-8 shrink-0 p-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M9 6l6 6-6 6" /></svg>
          </button>
          <span className="text-xs tracking-widest text-zinc-500 dark:text-zinc-400 xl:[writing-mode:vertical-rl]">
            章节目录
          </span>
        </div>
      )}
      {/* 左侧：章节目录（一件事一张卡，按卷分组、可展开搜索，与大纲页一致）。
          模块高度跟随内容，最多与页面底部对齐；内容多时在列表内滚动，避免整页滚动条。 */}
      <aside className={`${dirCollapsed ? "hidden" : "flex"} max-h-[calc(100dvh-6rem)] min-w-0 flex-col gap-4 overflow-hidden`}>
        <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="panel-head shrink-0">
            <h3 className="panel-title">章节目录</h3>
            <div className="flex items-center gap-2">
              <span className="panel-hint">{chapters.length} 章</span>
              <button
                type="button"
                onClick={() => onSetDir(true)}
                title="收起章节目录，正文与评价栏同时变宽"
                aria-label="收起章节目录"
                className="btn btn-ghost h-6 w-6 shrink-0 p-0"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M15 6l-6 6 6 6" /></svg>
              </button>
              <button
                type="button"
                onClick={() => {
                  // 生成中再次点击 = 重开弹窗查看生成进度：跳过「最新章须已定稿」门禁
                  if (!generating) {
                    // 最新一章尚未定稿 → 拦截：必须先定稿才能新增章节（空小说除外）
                    const latest = [...chapters].sort((a, b) => b.chapter_no - a.chapter_no)[0];
                    if (latest && latest.status !== "complete") {
                      showToast(
                        `最新一章（第 ${latest.chapter_no} 章）还是草稿，请先定稿后再新增章节。`,
                        "warning",
                      );
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
                      : "提取记忆层中，暂不能新增章节"
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
                          className={`mb-1.5 flex w-full items-start gap-1.5 text-left ${
                            chapterQ ? "cursor-default" : "cursor-pointer"
                          }`}
                        >
                          <span
                            className={`mt-0.5 shrink-0 text-[10px] text-zinc-400 transition-transform ${
                              isCollapsed ? "-rotate-90" : ""
                            }`}
                          >
                            ▾
                          </span>
                          <div className="min-w-0 flex-1">
                            <h4 className="text-xs font-bold text-zinc-500 dark:text-zinc-400">{g.label}</h4>
                            {g.subtitle && (
                              <span className="mt-0.5 block text-[10px] text-zinc-400">{g.subtitle}</span>
                            )}
                          </div>
                          <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{items.length} 章</span>
                        </button>
                        {!isCollapsed && (
                          <ul className="flex flex-col gap-2">
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
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium">
                                      第{c.chapter_no}章{listItemTitle(c) ? ` ${listItemTitle(c)}` : ""}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-zinc-500">
                                    {c.status === "complete" ? (
                                      <span className="rounded bg-green-100 px-1 py-0.5 text-green-700 dark:bg-green-900 dark:text-green-300">
                                        已定稿
                                      </span>
                                    ) : (
                                      <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">草稿</span>
                                    )}
                                    {c.active_source && <span>{sourceLabel(c.active_source)}</span>}
                                    {c.word_count != null && <span>{c.word_count}字</span>}
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

        {/* 本章操作：提取入记忆 / 复制正文，收在一张卡里。必须选中章节才能点（针对某一章）。
            shrink-0：高度固定，始终把目录面板挤到剩余的视口高度里去滚动。 */}
        <div className="panel shrink-0">
          <div className="panel-head">
            <h3 className="panel-title">本章操作</h3>
            {activeNo != null && (
              <span className="panel-hint">
                第 {activeNo} 章{activeChapter?.title ? ` ${activeChapter.title}` : ""}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {/* 重新生成正文：复用新增章节弹窗，基于当前章节重新生成一版正文（新增为一个草稿版本）。
                生成中不禁用：要能再次打开弹窗查看「查看生成过程」进度；但「新增章节」生成中需禁用——
                本次是新增而非重新生成，进度只能从「新增章节」入口重开查看；评价 / 提取进行中禁用。 */}
            <button
              type="button"
              onClick={onRegenerate}
              disabled={activeNo == null || (generating && !genIsRegenerate) || aiBusy}
              className="btn btn-ghost w-full"
              title={
                activeNo == null
                  ? "请先选择一章"
                  : aiBusy
                    ? reviewing
                      ? "评价进行中，暂不能重新生成正文"
                      : "提取记忆层中，暂不能重新生成正文"
                    : generating && !genIsRegenerate
                      ? "新增正文生成中，暂不能重新生成正文"
                      : "复用新增章节弹窗，基于当前章节重新生成一版正文（新增为一个草稿版本）"
              }
            >
              重新生成正文
            </button>
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
                        : "提取记忆层中，暂不能定稿"
                      : selectedVersion.signing_blocked
                        ? "该版本签约未过签（存在内容红线/抄袭类高危问题），定稿需二次确认"
                        : "将当前选中的草稿版本定稿为本章正文"
                }
              >
                定稿
              </button>
            )}
            {/* 评价入口统一在右侧「评价与优化」，本章操作只保留提取与复制 */}
            <button
              className={`relative w-full cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors ${
                extractPending
                  ? "border-blue-500 bg-gradient-to-r from-blue-200 to-blue-50 font-medium text-blue-800 hover:border-blue-600 hover:from-blue-300 hover:to-blue-100 dark:border-blue-500 dark:from-blue-800/80 dark:to-blue-950/60 dark:text-blue-300 dark:hover:border-blue-400 dark:hover:from-blue-800 dark:hover:to-blue-900/70 disabled:hover:border-blue-500 dark:disabled:hover:border-blue-500"
                  : "border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 disabled:hover:border-zinc-300 dark:disabled:hover:border-zinc-700"
              } disabled:cursor-not-allowed disabled:opacity-100`}
              onClick={onExtract}
              disabled={activeNo == null || extracting || reviewing || !selectedVersion || !selectedIsFinal}
              title={
                activeNo == null
                  ? "请先在章节目录选择一章"
                  : isStaleForActiveOutline
                    ? "当前正文基于旧版大纲生成，只能查看；请基于当前激活大纲重新生成正文并定稿后再提取"
                    : reviewing
                      ? "评价进行中，暂不能提取记忆层"
                      : !selectedVersion
                        ? "先选定版本再提取"
                        : !selectedIsFinal
                          ? "只有已定稿的正文才能提取入记忆层，请先在「本章操作」点「定稿」"
                          : extractPending
                            ? "当前版本尚未提取记忆层，重新提取后才会进入记忆（或已切到新版本）"
                            : "把本章摘要/角色状态/伏笔写进记忆层"
              }
            >
              {extracting ? "提取中…" : "提取 → 记忆层"}
              <span
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={(e) => e.stopPropagation()}
              >
                <InfoTip side="right">
                  <p className="font-medium text-zinc-700 dark:text-zinc-200">提取本章 = 给 AI 记账。</p>
                  把这一章的摘要、角色当前状态、新埋的伏笔等写进「记忆层」。
                  下一章生成时小说家会自动读到，角色性格的变化也靠它跟踪。
                  <span className="mt-1.5 block text-zinc-400">
                    每写完一章记得点一下，不然下一章可能「忘了」刚才发生了什么。
                  </span>
                </InfoTip>
              </span>
            </button>
            <button
              type="button"
              onClick={onCopy}
              disabled={activeNo == null || !selectedVersion}
              className="btn btn-ghost w-full"
            >
             复制本章正文
            </button>
            <div className="mt-1 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
              <CostHint />
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
