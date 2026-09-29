/**
 * @file constants/outline.ts
 * 大纲/章节相关共享常量：章节功能下拉项 FUNCTIONS、视角角色等级 ROLE_RANKS、阶段标签
 * STAGE_LABEL/STAGE_OPTIONS、节拍类型标签 TYPE_LABELS、兜底卷 DEFAULT_VOLUME 及卷信息类型 VolumeInfo。
 * 原 FUNCTIONS/ROLE_RANKS/STAGE_LABEL/DEFAULT_VOLUME 分别在大纲页与写作页/设定页重复定义，此处合为一份。
 */
import type { Blueprint } from "@/types/api";

/** 章节功能枚举（value / label）：生成表单下拉选项，留空 = 由大纲师按剧情节奏自动判定。
 *  写作页与大纲页共用同一份，保证两处下拉完全一致（默认空 = 自动判定）。 */
export const FUNCTIONS = [
  ["progression", "推进"],
  ["buildup", "铺垫"],
  ["turning", "转折"],
  ["climax", "高潮"],
  ["revelation", "揭秘"],
  ["resolution", "收束"],
  ["interlude", "间奏"],
] as const;

/** 视角角色按戏份分组（与设定库 role_rank 一致），方便区分主角 / 配角。 */
export const ROLE_RANKS = [
  { value: "protagonist", label: "主角" },
  { value: "major", label: "重要配角" },
  { value: "minor", label: "次要配角" },
  { value: "extra", label: "龙套 / 炮灰" },
] as const;

/** 章节所处阶段的中文标签（与蓝图 volumes 三分法、后端 derive_stage 保持一致）。 */
export const STAGE_LABEL: Record<string, string> = { early: "前期", middle: "中期", late: "后期" };

/** 阶段选项：设定生效的故事情节阶段（可多选；不选 = 不限制）。 */
export const STAGE_OPTIONS = [
  { value: "early", label: "前期" },
  { value: "middle", label: "中期" },
  { value: "late", label: "后期" },
];

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
