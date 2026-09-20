"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveOutline,
  friendlyRunError,
  getActiveBlueprint,
  listOutlines,
  listSettings,
  runAgent,
  type Blueprint,
  type Outline,
  type Setting,
} from "@/lib/api";
import Modal from "./modal";
import { message } from "@/components/message";
import Loading from "@/components/loading";
import { CostHint, useAiStatus } from "@/lib/ai-status";

interface Props {
  novelId: string;
}

interface GenForm {
  chapter_no: number;
  goal: string;
  chapter_function: string;
  pov: string;
}

const FUNCTIONS = [
  ["progression", "推进"],
  ["buildup", "铺垫"],
  ["turning", "转折"],
  ["climax", "高潮"],
  ["revelation", "揭秘"],
  ["resolution", "收束"],
  ["interlude", "间奏"],
] as const;

const EMPTY_FORM: GenForm = {
  chapter_no: 1,
  goal: "",
  chapter_function: "", // 留空 = 由大纲师按剧情节奏自动判定
  pov: "",
};

const FUNCTION_LABELS: Record<string, string> = Object.fromEntries(FUNCTIONS);

/** 视角角色按戏份分组（与设定库 role_rank 一致），方便区分主角 / 配角。 */
const ROLE_RANKS = [
  { value: "protagonist", label: "主角" },
  { value: "major", label: "重要配角" },
  { value: "minor", label: "次要配角" },
  { value: "extra", label: "龙套 / 炮灰" },
] as const;

function roleRankOf(s: Setting): string {
  const rk = s.structured?.role_rank;
  return typeof rk === "string" ? rk : "";
}

const STAGE_LABEL: Record<string, string> = { early: "前期", middle: "中期", late: "后期" };

/** 与后端 derive_stage 一致：按蓝图 volumes 最大结束章三分全书，推导章节所处阶段。 */
function deriveStage(chapterNo: number, volumes: VolumeInfo[] | undefined): string | null {
  if (!volumes || chapterNo <= 0) return null;
  let total = 0;
  for (const v of volumes) {
    const rng = v.chapters_range ?? "";
    const idx = rng.lastIndexOf("-");
    if (idx >= 0) {
      const end = Number(rng.slice(idx + 1).trim());
      if (Number.isFinite(end)) total = Math.max(total, end);
    }
  }
  if (total <= 0) return null;
  const third = total / 3;
  if (chapterNo <= third) return "early";
  if (chapterNo <= third * 2) return "middle";
  return "late";
}

/** 与后端 filter_settings_for_chapter 一致：角色在指定章节是否生效（生效阶段/章节范围）。 */
function isCharacterActive(
  c: Setting,
  chapterNo: number,
  volumes: VolumeInfo[] | undefined,
): boolean {
  const st = c.structured ?? {};
  if (typeof st.appear_from === "number" && chapterNo < st.appear_from) return false;
  if (typeof st.appear_until === "number" && chapterNo > st.appear_until) return false;
  const stage = deriveStage(chapterNo, volumes);
  if (stage && Array.isArray(st.stages) && st.stages.length > 0 && !st.stages.includes(stage)) {
    return false;
  }
  return true;
}

/** 该角色在指定章节不生效的原因（用于置灰展示，让被过滤的角色不会凭空消失）。 */
function inactiveReason(
  c: Setting,
  chapterNo: number,
  volumes: VolumeInfo[] | undefined,
): string {
  const st = c.structured ?? {};
  if (typeof st.appear_from === "number" && chapterNo < st.appear_from) {
    return `出场于第 ${st.appear_from} 章起`;
  }
  if (typeof st.appear_until === "number" && chapterNo > st.appear_until) {
    return `第 ${st.appear_until} 章后退场`;
  }
  const stage = deriveStage(chapterNo, volumes);
  if (stage && Array.isArray(st.stages) && st.stages.length > 0 && !st.stages.includes(stage)) {
    return `于${(st.stages as string[]).map((x) => STAGE_LABEL[x] ?? x).join("、")}阶段出场`;
  }
  return "本章未生效";
}

const TYPE_LABELS: Record<string, string> = {
  scene: "场景",
  transition: "过场",
  dialogue: "对话",
  action: "动作",
  reveal: "揭示",
};

type VolumeInfo = NonNullable<Blueprint["content"]["volumes"]>[number];

interface VolumeGroup {
  key: string;
  label: string;
  subtitle: string;
  items: Outline[];
}

/** 蓝图没有分卷（或卷的章节范围全无法解析）时的兜底卷：所有章节归入「第1卷」，避免散成「未分卷」。 */
const DEFAULT_VOLUME: VolumeInfo = { no: 1, name: "", focus: "", chapters_range: "" };

/** 把章节大纲按当前生效蓝图的 volumes（chapters_range）归组；蓝图无卷时兜底为默认「第1卷」。 */
function groupByVolume(outlines: Outline[], volumes: VolumeInfo[] | undefined): VolumeGroup[] {
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

  const groups: VolumeGroup[] = effectiveVols.map((v) => ({
    key: `vol-${v.no ?? v.name ?? "?"}`,
    label: `${v.no != null ? `第${v.no}卷` : "卷"}${v.name ? ` · ${v.name}` : ""}`,
    subtitle: [v.chapters_range && `${v.chapters_range}章`, v.chapter_count, v.word_count]
      .filter(Boolean)
      .join(" · "),
    items: [],
  }));
  const rest: VolumeGroup = { key: "rest", label: "未分卷", subtitle: "", items: [] };

  for (const o of [...outlines].sort((a, b) => a.chapter_no - b.chapter_no)) {
    const hit = effectiveParsed.find(({ start, end }) => o.chapter_no >= start && o.chapter_no <= end);
    const target = hit
      ? groups.find((g) => g.key === `vol-${hit.v.no ?? hit.v.name ?? "?"}`)
      : undefined;
    (target ?? rest).items.push(o);
  }

  const result = groups.filter((g) => g.items.length > 0);
  if (rest.items.length > 0) result.push(rest);
  return result;
}

export default function OutlinePanel({ novelId }: Props) {
  const [outlines, setOutlines] = useState<Outline[]>([]);
  // 数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(true);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  /** 生效蓝图标题：null = 无生效蓝图（新增大纲的前提，无蓝图时弹窗内提示并禁用生成）。 */
  const [blueprintTitle, setBlueprintTitle] = useState<string | null>(null);
  const [characters, setCharacters] = useState<Setting[]>([]);
  const [form, setForm] = useState<GenForm>(EMPTY_FORM);
  const [generating, setGenerating] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 被折叠的卷 key（默认全展开）。搜索时强制展开匹配卷（与写作页章节目录一致）。 */
  const [collapsedKeys, setCollapsedKeys] = useState<Record<string, boolean>>({});
  /** 大纲搜索词（按章号/标题过滤）。 */
  const [outlineSearch, setOutlineSearch] = useState("");
  // 新增大纲弹窗（参考蓝图页「新增蓝图」：按钮 + Modal）
  const [showAddModal, setShowAddModal] = useState(false);
  // 本次生成成功落库的章节号（stored 事件写入，供完成后关闭弹窗、顺延默认章节号、选中新草稿）
  const storedChapterRef = useRef<number | null>(null);
  const { ensureReady } = useAiStatus();

  // 思考过程文字自动滚到底部
  const thinkRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = thinkRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thinkingText, generating]);

  const load = useCallback(async (): Promise<Outline[]> => {
    setLoading(true);
    try {
      const [outs, bp, chars] = await Promise.all([
        listOutlines(novelId),
        getActiveBlueprint(novelId).catch(() => null), // 无 active 蓝图不阻塞大纲加载
        listSettings(novelId, "character").catch(() => [] as Setting[]), // 视角角色下拉
      ]);
      setOutlines(outs);
      setVolumes(bp?.content?.volumes ?? []);
      setBlueprintTitle(bp?.content?.title ?? null);
      setCharacters(chars);
      // 有数据时默认选中最新一章（章节号最大）；无选中才生效，不覆盖用户当前选择
      setSelectedId((cur) => {
        if (cur) return cur;
        if (outs.length === 0) return null;
        return outs.reduce((a, b) => (a.chapter_no > b.chapter_no ? a : b)).id;
      });
      return outs;
    } catch (e) {
      message.error((e as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = outlines.find((o) => o.id === selectedId) ?? null;
  const groups = groupByVolume(outlines, volumes);
  // 搜索：按「第N章 标题」过滤，空搜索时保持按卷归组（与写作页章节目录一致）
  const outlineQ = outlineSearch.trim().toLowerCase();
  const outlineMatches = (o: Outline) =>
    !outlineQ || `第${o.chapter_no}章 ${o.title ?? ""}`.toLowerCase().includes(outlineQ);

  // 视角角色：仅列出当前章节号下生效的角色（生效阶段/出场章节范围/隐藏 与后端过滤一致）
  const stage = deriveStage(form.chapter_no, volumes);
  const activeCharacters = characters.filter((c) => isCharacterActive(c, form.chapter_no, volumes));
  const inactiveCharacters = characters.filter(
    (c) => !isCharacterActive(c, form.chapter_no, volumes),
  );

  /** 自动推导下一个大纲章节号：已有大纲（含草稿）的最大章号 + 1；还没有任何大纲则从第一卷第一章开始 */
  function nextAutoChapterNo(list: Outline[], vols: VolumeInfo[]): number {
    if (list.length === 0) {
      // 第一卷的起始章号（chapters_range 的左边界），无法解析则回退到 1
      const m = vols[0]?.chapters_range?.match(/(\d+)\s*[-~至到]\s*(\d+)/);
      return m ? Number(m[1]) : 1;
    }
    return Math.max(...list.map((o) => o.chapter_no)) + 1;
  }

  /** 打开「新增大纲」弹窗：每次打开按当前大纲重算自动章节号，并清空上次表单 */
  function openAddModal() {
    setForm({ ...EMPTY_FORM, chapter_no: nextAutoChapterNo(outlines, volumes) });
    setShowAddModal(true);
  }

  const content = selected?.content as
    | {
        no?: number;
        title?: string;
        goal?: string;
        chapter_function?: string;
        pov?: string;
        beats?: Array<{ beat_no?: number; type?: string; pov?: string; content?: string; length_hint?: string; emotion?: string }>;
        conflicts?: Array<{ type?: string; with?: string; stakes?: string }>;
        plant_foreshadowing?: Array<{ desc?: string; payoff_hint?: string; latest_payoff_chapter?: number }>;
        resolve_foreshadowing?: Array<{ ledger_id?: string; how?: string }>;
        thread_updates?: Array<{ thread?: string; new_state?: string }>;
      }
    | undefined;

  async function handleGenerate() {
    setGenerating(true);
    setDraftText("");
    setThinkingText("");
    storedChapterRef.current = null;
    const params: Record<string, unknown> = {
      chapter_no: form.chapter_no,
      goal: form.goal.trim() || undefined,
      chapter_function: form.chapter_function,
      pov: form.pov.trim() || undefined,
    };
    try {
      ensureReady();
      await runAgent("outliner", novelId, params, (ev) => {
        const d = ev.data as { delta?: string; status?: string; chapter_no?: number };
        if (ev.event === "thinking_delta" && d.delta) {
          setThinkingText((prev) => prev + d.delta);
        } else if (ev.event === "stream_delta" && d.delta) {
          setDraftText((prev) => prev + d.delta);
        } else if (ev.event === "schema_validate") {
          if (d.status !== "ok") message.error("大纲 schema 校验失败，可重试。");
        } else if (ev.event === "stored") {
          if (typeof d.chapter_no === "number") storedChapterRef.current = d.chapter_no;
          message.success("大纲已落库（draft），并登记伏笔账本。可在详情里批准生效。");
        } else if (ev.event === "stream_error") {
          message.error((ev.data as { message?: string }).message ?? "AI 生成大纲出错，请稍后重试。");
        }
      });
    } catch (e) {
      message.error(friendlyRunError(e));
    } finally {
      setGenerating(false);
      setDraftText("");
      setThinkingText("");
      const outs = await load();
      const storedNo = storedChapterRef.current;
      storedChapterRef.current = null;
      if (storedNo != null) {
        // 生成成功：关闭弹窗、默认章节号顺延到下一条、选中刚生成的草稿
        setShowAddModal(false);
        const created = outs.find((o) => o.chapter_no === storedNo);
        setSelectedId(created?.id ?? null);
        setForm({ ...EMPTY_FORM, chapter_no: storedNo + 1 });
      }
    }
  }

  async function handleApprove(o: Outline) {
    try {
      await approveOutline(novelId, o.id);
      message.success(`第 ${o.chapter_no} 章大纲已批准生效（小说家生成时将优先引用）。`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  /** 点击卷标题：收缩 / 展开该卷下的章节列表 */
  function toggleCollapse(key: string) {
    setCollapsedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <Loading loading={loading}>
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)] xl:gap-8">
      {/* 左侧：章节大纲（与写作页「章节目录」模块统一：按卷分组、可展开、可搜索）。
          模块高度跟随内容，最多与页面底部对齐；内容多时在列表内滚动，互不影响其他模块。 */}
      <aside className="flex max-h-[calc(100dvh-6rem)] min-w-0 flex-col gap-4 overflow-hidden">
        <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="panel-head shrink-0">
            <h3 className="panel-title">章节大纲</h3>
            <div className="flex items-center gap-2">
              <span className="panel-hint">{outlines.length} 条</span>
              <button
                type="button"
                onClick={() => openAddModal()}
                className="btn btn-primary px-2.5 py-1 text-xs font-medium"
              >
                新增大纲
              </button>
            </div>
          </div>
          {outlines.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有大纲。点右上角「新增大纲」，让大纲师产出第 N 章大纲。
            </p>
          ) : (
            <>
              <input
                className="mb-3 w-full shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                placeholder="搜索大纲（章号 / 标题）"
                value={outlineSearch}
                onChange={(e) => setOutlineSearch(e.target.value)}
              />
              <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                {groups
                  .map((g) => {
                    const items = outlineQ ? g.items.filter(outlineMatches) : g.items;
                    return items.length > 0 ? { g, items } : null;
                  })
                  .filter((x): x is { g: VolumeGroup; items: Outline[] } => x != null)
                  .map(({ g, items }, idx, arr) => {
                    const collapsed = !outlineQ && collapsedKeys[g.key];
                    const isLast = idx === arr.length - 1;
                    return (
                      <section key={g.key} className={isLast ? "" : "mb-2"}>
                        <button
                          type="button"
                          onClick={() => !outlineQ && toggleCollapse(g.key)}
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
                            {g.subtitle && (
                              <span className="mt-0.5 block text-[10px] text-zinc-400">{g.subtitle}</span>
                            )}
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
                                  onClick={() => setSelectedId(o.id)}
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
                                        草稿
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

      {/* 右侧：大纲详情 */}
      <section className="flex min-w-0 flex-col gap-5 sm:gap-7">
        {!selected && (
          <div className="panel flex min-h-0 flex-col gap-3">
            <div className="panel-head mb-0">
              <h3 className="panel-title">大纲详情</h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有大纲。点左侧「新增大纲」，让大纲师排出第一章大纲。
            </p>
          </div>
        )}

        {/* 大纲详情 */}
        {selected && (
          <div className="panel flex max-h-[calc(100dvh-6rem)] min-h-0 flex-col overflow-hidden">
            <div className="panel-head shrink-0">
              <h3 className="panel-title">
                第 {selected.chapter_no} 章大纲
                {selected.title ? ` ${selected.title}` : ""}
                {content?.pov ? <span className="ml-2 text-xs font-normal text-zinc-500">视角：{content.pov}</span> : null}
                {content?.chapter_function ? (
                  <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    节奏：{FUNCTION_LABELS[content.chapter_function] ?? content.chapter_function}
                  </span>
                ) : null}
              </h3>
              {selected.status === "draft" && (
                <button
                  className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-600"
                  onClick={() => handleApprove(selected)}
                >
                  批准生效
                </button>
              )}
            </div>

            {/* 详情正文：超出页面高度时在该区域内滚动，头部「批准生效」保持可见 */}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {content?.goal && (
              <p className="mb-3 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
                <span className="font-semibold">目标：</span>
                {content.goal}
              </p>
            )}

            {content?.beats && content.beats.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">节拍（beats）</h4>
                <ol className="flex flex-col gap-1.5">
                  {content.beats.map((b, i) => (
                    <li key={i} className="rounded-lg border border-zinc-200 p-2.5 text-sm dark:border-zinc-800">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                          #{b.beat_no ?? i + 1} · {TYPE_LABELS[b.type ?? ""] ?? b.type ?? "场景"}
                        </span>
                        {b.pov && <span>视角 {b.pov}</span>}
                        {b.length_hint && <span>{b.length_hint}</span>}
                        {b.emotion && <span>情绪：{b.emotion}</span>}
                      </div>
                      <div className="text-zinc-700 dark:text-zinc-300">{b.content}</div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {content?.conflicts && content.conflicts.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">冲突</h4>
                <ul className="flex flex-col gap-1">
                  {content.conflicts.map((c, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] dark:bg-zinc-800">
                        {c.type === "internal" ? "内心" : "外部"}
                      </span>{" "}
                      与{c.with} · 赌注：{c.stakes}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {content?.plant_foreshadowing && content.plant_foreshadowing.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">埋设伏笔（入账）</h4>
                <ul className="flex flex-col gap-1">
                  {content.plant_foreshadowing.map((p, i) => (
                    <li key={i} className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm dark:border-amber-900 dark:bg-amber-950">
                      {p.desc}
                      <span className="ml-2 text-[11px] text-zinc-500">
                        {p.payoff_hint ? `回收线索：${p.payoff_hint} · ` : ""}
                        {p.latest_payoff_chapter ? `最迟第${p.latest_payoff_chapter}章` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {content?.resolve_foreshadowing && content.resolve_foreshadowing.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-green-600 dark:text-green-400">回收伏笔（置 closed）</h4>
                <ul className="flex flex-col gap-1">
                  {content.resolve_foreshadowing.map((r, i) => (
                    <li key={i} className="rounded-lg border border-green-200 bg-green-50 p-2 text-sm dark:border-green-900 dark:bg-green-950">
                      #{String(r.ledger_id ?? "").slice(0, 8)} — {r.how}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {content?.thread_updates && content.thread_updates.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">线索推进（入账）</h4>
                <ul className="flex flex-col gap-1">
                  {content.thread_updates.map((t, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      线索「{t.thread}」→ {t.new_state}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            </div>
          </div>
        )}
      </section>

      {/* ── 新增大纲弹窗（参考蓝图页「新增蓝图」/写作页「新增章节」：按钮 + Modal） ── */}
      <Modal
        open={showAddModal}
        title="新增大纲"
        subtitle="大纲 = 单章的施工图。大纲师按当前生效蓝图，排出这一章的目标、节拍（beats）、冲突和视角。生成的是「草稿」，批准生效后，小说家写这一章时会优先照它来。"
        onClose={() => setShowAddModal(false)}
        maxWidth="max-w-xl"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="btn btn-ghost px-4 py-1.5"
            >
              取消
            </button>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline">
                <CostHint />
              </span>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating || !blueprintTitle}
                className="btn btn-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generating ? "生成中…" : "生成大纲"}
              </button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {/* 无生效蓝图时提醒（新增大纲的前提）；有蓝图则不打扰 */}
          {!blueprintTitle && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-6 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              还没有生效的蓝图，无法生成大纲。
              <br />
              请先到「蓝图」页创建蓝图并设为生效，再回来新增大纲。
            </div>
          )}

          {/* 章节号不手动填写：打开弹窗时已自动推导（已有大纲最大章号 + 1，无则从第一卷第一章开始） */}
          <span className="text-[11px] text-zinc-400">
            将自动生成：第 {form.chapter_no} 章
            {stage ? `（当前处于：${STAGE_LABEL[stage]}，视角角色按此过滤）` : ""}
          </span>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">视角角色</span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.pov}
              onChange={(e) => setForm({ ...form, pov: e.target.value })}
              disabled={generating}
            >
              <option value="">
                {activeCharacters.length > 0
                  ? "视角角色（留空由大纲师自定）"
                  : "该章节无生效角色（留空由大纲师自定）"}
              </option>
              {ROLE_RANKS.map((g) => {
                const items = activeCharacters.filter((c) => roleRankOf(c) === g.value);
                if (items.length === 0) return null;
                return (
                  <optgroup key={g.value} label={g.label}>
                    {items.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
              {activeCharacters.some((c) => !ROLE_RANKS.some((g) => roleRankOf(c) === g.value)) && (
                <optgroup label="未标注等级">
                  {activeCharacters
                    .filter((c) => !ROLE_RANKS.some((g) => roleRankOf(c) === g.value))
                    .map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              )}
              {inactiveCharacters.length > 0 && (
                <optgroup label="本章未生效（置灰不可选）">
                  {inactiveCharacters.map((c) => (
                    <option key={c.id} value={c.name} disabled>
                      {c.name}（{inactiveReason(c, form.chapter_no, volumes)}）
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">章节功能</span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.chapter_function}
              onChange={(e) => setForm({ ...form, chapter_function: e.target.value })}
              disabled={generating}
            >
              <option value="">章节功能：自动判定</option>
              {FUNCTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  章节功能：{l}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">本章目标</span>
            <textarea
              className="resize-none rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder="本章目标（goal，留空则由大纲师自行把握）"
              rows={2}
              value={form.goal}
              onChange={(e) => setForm({ ...form, goal: e.target.value })}
              disabled={generating}
            />
          </label>

          {/* 生成中：思考过程（DeepSeek 风格，实时滚动） */}
          {generating && !draftText && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 dark:border-blue-900 dark:bg-blue-950">
              <div className="flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-blue-500" />
                模型正在推理中，思考过程实时显示在下方（可能需 1～3 分钟）
              </div>
              <div
                ref={thinkRef}
                className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-zinc-600 dark:text-zinc-400"
              >
                {thinkingText || "正在连接模型…"}
              </div>
            </div>
          )}

          {/* 生成中：流式输出 */}
          {generating && draftText && (
            <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-3.5 py-2 dark:border-zinc-800">
                <h4 className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">大纲师流式输出</h4>
                <span className="font-mono text-[11px] text-zinc-400">正在逐字生成…</span>
              </div>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap px-3.5 py-2.5 font-mono text-xs leading-6 text-zinc-700 dark:text-zinc-300">
                {draftText}
              </pre>
            </div>
          )}
        </div>
      </Modal>
      </div>
    </Loading>
  );
}
