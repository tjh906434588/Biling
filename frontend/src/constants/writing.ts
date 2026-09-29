/**
 * @file constants/writing.ts
 * 写作页相关共享常量：评价维度/追读力子项/问题严重度的中文标签、联动重写中断总展示时长、
 * 评价栏宽度预设、版本来源友好标签。原定义均在 writing-panel.tsx 内，此处集中维护。
 */

/** 评价维度英文 key → 用户可读中文（界面直接展示用）。 */
export const RUBRIC_LABELS: Record<string, string> = {
  blueprint_adherence: "蓝图贴合度",
  consistency: "前后一致性",
  character_voice: "角色口吻",
  pacing: "节奏把控",
  style_compliance: "文风与语言",
  foreshadowing_accountability: "伏笔交代",
  reader_retention: "读者追读",
};

/** 追读力子项英文 key → 中文。 */
export const RETENTION_HOOK_LABELS: Record<string, string> = {
  opening_hook: "开篇钩子",
  ending_hook: "章末悬念",
  tension: "情绪张力",
  anticipation: "期待感",
};

/** 问题严重度 → 中文。 */
export const SEVERITY_LABELS: Record<string, string> = {
  high: "严重",
  medium: "中等",
  low: "轻微",
};

/** 联动重写中断通知的总展示时长（ms）：只累计「页面可见时间」，离开页面暂停、回来继续。 */
export const REWRITE_FAIL_TOTAL_MS = 15_000;

/** 评价栏宽度（px）：三档预设切换，xl 起生效。偏好存 localStorage，跨刷新保持。 */
export const REVIEW_W_DEFAULT = 620;
export const REVIEW_W_MIN = 340;
export const REVIEW_W_MAX = 1000;
/** 评价栏三档预设（窄 / 中 / 宽），点一下即切换。 */
export const REVIEW_W_PRESETS: ReadonlyArray<readonly [string, number]> = [
  ["窄", 420],
  ["中", 620],
  ["宽", 860],
];

/** 版本来源的友好标签（章节详情版本列表用）。 */
export const SOURCE_LABELS: Record<string, string> = {
  novelist: "初稿", // 新增章节首次生成
  regenerate: "再稿", // 重新生成正文（novelist，根层平级）
  reviser: "修订稿", // 评价优化（按评价修订）
  merged: "手动合并",
};
