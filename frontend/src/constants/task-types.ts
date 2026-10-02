/**
 * @file constants/task-types.ts
 * 五类 AI 任务类型的**单一事实源**：key + 中文标签 + 提示语。
 *
 * - `types/api.ts` 的 ModelRoute.task_type 类型由它推导（TaskType）
 * - `models-panel.tsx` 的「高级设置」任务标签/提示由它提供
 * - 后端 `backend/app/api/models.py` 的 TASK_TYPES 为跨端契约的另一份（后端权威）
 *
 * 新增/修改任务类型：前端只改这里即可，types 与 UI 自动跟随；
 * 同时必须同步后端 `backend/app/api/models.py` 的 TASK_TYPES（前后端契约）。
 */
export const TASK_TYPES = [
  { key: "setting", label: "设定", hint: "规划世界观、人物与大章节大纲，定下故事骨架" },
  { key: "creation", label: "创作", hint: "写每一章的正文内容" },
  { key: "extract", label: "提取", hint: "把已写的章节自动整理成剧情要点和人物信息，供后续写作参考" },
  { key: "chronicle", label: "编年", hint: "定期把前文浓缩成故事脉络，防止写久了忘掉早期伏笔" },
  { key: "review", label: "评价", hint: "审读章节质量，发现问题并给出修改建议" },
] as const;

/** 任务类型 key 联合类型（由 TASK_TYPES 推导，不重复定义）。 */
export type TaskType = (typeof TASK_TYPES)[number]["key"];
