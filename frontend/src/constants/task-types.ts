/**
 * @file constants/task-types.ts
 * AI 任务类型的**编译期类型约束源**：仅维护 key 清单（TaskType 由它推导）。
 *
 * - `types/api.ts` 的 ModelRoute.task_type 类型由它推导（TaskType）
 * - `models-panel.tsx` 的「高级设置」任务标签/提示由 `loadTaskTypes()` 提供
 * - 任务类型**文案（label/hint）不在此维护**——由后端 `GET /api/models/task-types`
 *   接口返回（后端 `api/models.py` 的 TASK_TYPES 为唯一事实源），避免新增任务类型时
 *   前端漏写文案；本文件 key 清单的编译期约束保证后端新增类型时前端编译报错提醒同步。
 */
import { loadMetaDict } from "@/lib/meta-dict";
import type { TaskTypeMeta } from "@/types/api";

/** 任务类型 key 静态清单（编译期类型约束 + 表单初始化/保存顺序）。 */
export const TASK_TYPES = [
  "setting",
  "check",
  "planning",
  "creation",
  "extract",
  "review",
  "chronicle",
] as const;

/** 任务类型 key 联合类型（由 TASK_TYPES 推导，不重复定义）。 */
export type TaskType = (typeof TASK_TYPES)[number];

/** 拉取任务类型文案（后端 /api/meta 单一源，统一缓存命中不再请求）；失败回落静态 key 兜底。 */
export async function loadTaskTypes(): Promise<TaskTypeMeta[]> {
  try {
    return await loadMetaDict<TaskTypeMeta[]>("task_types");
  } catch {
    return TASK_TYPES.map((key) => ({ key, label: key, hint: "", roles: [] }));
  }
}
