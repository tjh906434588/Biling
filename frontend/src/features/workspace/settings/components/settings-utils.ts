/**
 * @file components/settings/settings-utils.ts
 * 设定面板的模块级类型与常量（由 settings-panel.tsx 按逻辑边界拆分）：
 * FormState / EMPTY_FORM（新增/编辑设定弹窗的表单状态，保存时拼 structured 字段）
 * 与 ROLE_RANK_STYLE / STAGE_STYLE（角色等级、生效阶段的标签样式类，仅本面板使用）。
 * 设定类型/角色等级/阶段的 label 为枚举字典（后端 meta.py 单一源），由各组件经
 * loadSettingTypes / loadRoleRanks / loadStages 拉取，不在此维护。
 */
import type { SettingType } from "@/lib/api";
import type { Seg } from "./timing";

/** 角色等级：AI 据此分配篇幅与视角权重。 */
export const ROLE_RANK_STYLE: Record<string, string> = {
  protagonist: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  major: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  minor: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  extra: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

/** 阶段标签：设定生效的故事情节阶段（可多选；不选 = 不限制）。 */
export const STAGE_STYLE: Record<string, string> = {
  early: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  middle: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  late: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
};

/** 「新增/编辑设定」弹窗的表单状态。 */
export interface FormState {
  type: SettingType;
  name: string;
  role_rank: string;
  is_background: boolean;
  constitution_text: string;
  dynamic_text: string;
  appear_segments: Seg[];
  stages: string[];
}

/** 新增设定的初始表单（每次打开弹窗重置为全新状态）。 */
export const EMPTY_FORM: FormState = {
  type: "character",
  name: "",
  role_rank: "protagonist",
  is_background: false,
  constitution_text: "",
  dynamic_text: "",
  appear_segments: [],
  stages: [],
};
