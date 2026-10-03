/**
 * @file constants/outline.ts
 * 大纲/章节相关共享常量：节拍类型标签 TYPE_LABELS、兜底卷 DEFAULT_VOLUME 及卷信息类型 VolumeInfo。
 * 章节功能下拉项（推进/铺垫/…）已迁移为枚举字典（后端 meta.py 的 chapter_functions 单一源，
 * 见 loadChapterFunctions），不再在此维护中文 label，避免与确认面板等处漂移。
 * 视角角色等级 ROLE_RANKS / 阶段标签 STAGE_LABEL 亦已迁移为枚举字典（role_ranks / stages）。
 */
import type { Blueprint } from "@/types/api";
import { loadMetaDict } from "@/lib/meta-dict";

/** 章节功能下拉项（字典下发，value + label；后端 meta.py 单一源，统一缓存命中不再请求）。 */
export interface ChapterFunctionOption {
  value: string;
  label: string;
}

/** 拉取章节功能下拉项（后端单一源）；失败回退空数组（下拉只剩「自动判定」选项）。 */
export async function loadChapterFunctions(): Promise<ChapterFunctionOption[]> {
  try {
    return await loadMetaDict<ChapterFunctionOption[]>("chapter_functions");
  } catch {
    return [];
  }
}

/** 章节功能 label 映射（由字典派生，供详情/确认展示用）；失败回退空映射（显示原始 value）。 */
export async function loadFunctionLabels(): Promise<Record<string, string>> {
  try {
    const list = await loadMetaDict<ChapterFunctionOption[]>("chapter_functions");
    return Object.fromEntries(list.map((f) => [f.value, f.label]));
  } catch {
    return {};
  }
}

/** 视角角色按戏份分组（与设定库 role_rank 一致，方便区分主角 / 配角；枚举字典后端单一源）。 */
export interface RoleRankOption {
  value: string;
  label: string;
}

/** 拉取视角角色等级分组（后端 meta.py 单一源，统一缓存）；失败回退空数组。 */
export async function loadRoleRanks(): Promise<RoleRankOption[]> {
  try {
    return await loadMetaDict<RoleRankOption[]>("role_ranks");
  } catch {
    return [];
  }
}

/** 章节所处阶段（early/middle/late；枚举字典后端单一源，列表顺序即展示顺序）。 */
export interface StageOption {
  value: string;
  label: string;
}

/** 拉取章节阶段选项（后端 meta.py 单一源，统一缓存）；失败回退空数组。 */
export async function loadStages(): Promise<StageOption[]> {
  try {
    return await loadMetaDict<StageOption[]>("stages");
  } catch {
    return [];
  }
}

/** 拉取阶段中文标签映射（由 stages 字典派生，供展示用）；失败回退空映射（显示原始 value）。 */
export async function loadStageLabel(): Promise<Record<string, string>> {
  try {
    const list = await loadMetaDict<StageOption[]>("stages");
    return Object.fromEntries(list.map((s) => [s.value, s.label]));
  } catch {
    return {};
  }
}

/** 节拍类型 → 中文标签（大纲详情「节拍」列表展示）。 */
export const TYPE_LABELS: Record<string, string> = {
  scene: "场景",
  transition: "过场",
  dialogue: "对话",
  action: "动作",
  reveal: "揭示",
};

/** 卷信息（与蓝图 content.volumes 一致，用于章节目录/大纲按卷分组）。 */
export type VolumeInfo = NonNullable<Blueprint["content"]["volumes"]>[number];

/** 蓝图没有分卷（或卷的章节范围全无法解析）时的兜底卷：所有章节归入「第1卷」，避免散成「未分卷」。 */
export const DEFAULT_VOLUME: VolumeInfo = { no: 1, name: "", focus: "", chapters_range: "" };

/** 从卷 name 里剥离冗余信息，生成干净的卷标签。
 * 蓝图 LLM 偶尔把「第X卷」前缀与【年代】段写进 name（如 第一卷：懵懂入行·系统初醒【2000—2002】），
 * 而前端已拼「第{no}卷」前缀 → 直接拼接会显示成「第1卷 · 第一卷：…」重复、且年代混入卷名。
 * 这里统一净化：去【】/[] 内的年代段、去开头「第X卷」前缀，只留纯卷名；前端两处（章节目录/大纲）共用。 */
export function formatVolumeLabel(no: number | undefined, name: string | undefined): string {
  let n = (name ?? "")
    .replace(/【[^】]*】/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .trim();
  n = n.replace(/^第\s*[一二三四五六七八九十百千万零〇\d]+\s*卷\s*[:：、.。\-—\s]*/, "").trim();
  const head = no != null ? `第${no}卷` : "卷";
  return n ? `${head} · ${n}` : head;
}
