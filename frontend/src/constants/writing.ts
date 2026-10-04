/**
 * @file constants/writing.ts
 * 写作页相关共享常量：评价维度/追读力子项/问题严重度/版本来源的中文标签已迁移为枚举字典
 * （后端 /api/meta 单一源，见 loadRubricLabels / loadRetentionHookLabels / loadSeverityLabels /
 * loadSourceLabels），联动重写中断总展示时长、评价栏宽度预设为固定配置，前端写死。
 */
import { loadMetaDict } from "@/lib/meta-dict";

/** 拉取评价维度中文标签（key 由后端 QualityReview.rubric 产生，统一缓存）；失败回退空映射。 */
export async function loadRubricLabels(): Promise<Record<string, string>> {
  try {
    return await loadMetaDict<Record<string, string>>("rubric_labels");
  } catch {
    return {};
  }
}

/** 拉取追读力子项中文标签（rubric.reader_retention 子维度）；失败回退空映射。 */
export async function loadRetentionHookLabels(): Promise<Record<string, string>> {
  try {
    return await loadMetaDict<Record<string, string>>("retention_hook_labels");
  } catch {
    return {};
  }
}

/** 拉取问题严重度中文标签（high/medium/low）；失败回退空映射。 */
export async function loadSeverityLabels(): Promise<Record<string, string>> {
  try {
    return await loadMetaDict<Record<string, string>>("severity_labels");
  } catch {
    return {};
  }
}

/** 拉取章节版本来源中文标签（初稿/再稿/修订稿/手动合并）；失败回退空映射。 */
export async function loadSourceLabels(): Promise<Record<string, string>> {
  try {
    return await loadMetaDict<Record<string, string>>("source_labels");
  } catch {
    return {};
  }
}

/** 联动重写中断通知的总展示时长（ms）：只累计「页面可见时间」，离开页面暂停、回来继续。 */
export const REWRITE_FAIL_TOTAL_MS = 15_000;

/** 评价栏占剩余横向空间的比例（百分比）：三档预设切换，xl 起生效。偏好存 localStorage。 */
export const REVIEW_RATIO_DEFAULT = 30;
export const REVIEW_RATIO_MIN = 20;
export const REVIEW_RATIO_MAX = 70;
/** 评价栏三档预设（窄 / 中 / 宽）：正文与评价栏按剩余空间比例分配。 */
export const REVIEW_RATIO_PRESETS: ReadonlyArray<readonly [string, number]> = [
  ["窄", 30],
  ["中", 50],
  ["宽", 70],
];
