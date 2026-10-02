/**
 * @file components/outline/outline-utils.ts
 * 大纲页纯函数、类型与常量（由 outline-panel.tsx 按逻辑边界拆分）：
 * 角色在指定章节的生效判定（roleRankOf/deriveStage/isCharacterActive/inactiveReason，与后端逻辑一致）、
 * 按蓝图分卷归组（groupByVolume）、生成表单类型（GenForm/EMPTY_FORM）、章节号自动推导（nextAutoChapterNo）、
 * 详情正文结构（OutlineContent）与章节功能标签（FUNCTION_LABELS）。不依赖组件状态，可独立复用/测试。
 */
import type { Setting, Outline } from "@/lib/api";
import {
  DEFAULT_VOLUME,
  FUNCTIONS,
  STAGE_LABEL,
  formatVolumeLabel,
  type VolumeInfo,
} from "@/constants";

/** 生成表单：章节号 + 目标 + 章节功能 + 视角（打开弹窗时重置；重写模式章节号锁定）。 */
export interface GenForm {
  chapter_no: number;
  goal: string;
  chapter_function: string;
  pov: string;
}

export const EMPTY_FORM: GenForm = {
  chapter_no: 1,
  goal: "",
  chapter_function: "", // 留空 = 由大纲师按剧情节奏自动判定
  pov: "",
};

export const FUNCTION_LABELS: Record<string, string> = Object.fromEntries(FUNCTIONS);

/** 读取设定的戏份等级 role_rank（视角角色按戏份分组下拉用）。 */
export function roleRankOf(s: Setting): string {
  const rk = s.structured?.role_rank;
  return typeof rk === "string" ? rk : "";
}

/** 与后端 derive_stage 一致：按蓝图 volumes 最大结束章三分全书，推导章节所处阶段。 */
export function deriveStage(chapterNo: number, volumes: VolumeInfo[] | undefined): string | null {
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
export function isCharacterActive(
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
export function inactiveReason(
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

export interface VolumeGroup {
  key: string;
  label: string;
  items: Outline[];
}

/** 把章节大纲按当前生效蓝图的 volumes（chapters_range）归组；蓝图无卷时兜底为默认「第1卷」。 */
export function groupByVolume(outlines: Outline[], volumes: VolumeInfo[] | undefined): VolumeGroup[] {
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
    label: formatVolumeLabel(v.no, v.name),
    items: [],
  }));
  const rest: VolumeGroup = { key: "rest", label: "未分卷", items: [] };

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

/** 自动推导下一个大纲章节号：已有大纲（含草稿）的最大章号 + 1；还没有任何大纲则从第一卷第一章开始。 */
export function nextAutoChapterNo(list: Outline[], vols: VolumeInfo[]): number {
  if (list.length === 0) {
    // 第一卷的起始章号（chapters_range 的左边界），无法解析则回退到 1
    const m = vols[0]?.chapters_range?.match(/(\d+)\s*[-~至到]\s*(\d+)/);
    return m ? Number(m[1]) : 1;
  }
  return Math.max(...list.map((o) => o.chapter_no)) + 1;
}

/** 大纲详情正文结构（viewing.content 解析后的字段，供详情面板渲染）。 */
export interface OutlineContent {
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
