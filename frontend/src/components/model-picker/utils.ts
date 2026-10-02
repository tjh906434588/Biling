/**
 * @file components/model-picker/utils.ts
 * 模型选择弹窗的模块级纯函数、类型与常量（由 model-picker-modal.tsx 按逻辑边界拆分）：
 * View（当前所处视图：自定义表单 / 服务商详情）、CustState（自定义模型表单状态）、
 * ConfigMode（多配置方式条目）、EnabledModel（已接入模型）、LiveOverride（刷新模型列表结果覆盖）、
 * inputCls/labelCls（表单控件统一样式类）与 isDefaultModel（默认模型判定）。
 * 不依赖组件状态，可独立复用/测试。
 */
import type { CatalogProvider, DefaultModel } from "@/lib/api";

/** 当前所处视图：自定义表单 / 某个服务商详情。 */
export type View = "custom" | CatalogProvider;

/** 自定义模型配置表单的状态（label/api_format/base_url/model_id/api_key）。 */
export interface CustState {
  label: string;
  api_format: "openai" | "anthropic";
  base_url: string;
  model_id: string;
  api_key: string;
}

/** 多配置方式服务商（如火山方舟：ark-code-latest 自动 / model-name 指定模型名）的一个配置方式条目。 */
export type ConfigMode = NonNullable<CatalogProvider["config_modes"]>[number];

/** 已接入模型（一个 Key 可用同服务商多个模型，其中一个是默认）。 */
export interface EnabledModel {
  model: string;
  label: string;
}

/** 「刷新模型列表」结果覆盖：用有效 Key 从服务商拉到的账号真实模型，覆盖静态种子下拉（刷新后优先展示）。 */
export interface LiveOverride {
  provider: string;
  models: { id: string; label: string }[];
  updatedAt: string;
}

/** 表单控件统一样式类（输入框/下拉框）。 */
export const inputCls =
  "mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900";

/** 表单字段标签样式类。 */
export const labelCls = "block text-xs text-zinc-500";

/** 该模型是否当前默认模型（用于展示「当前在用」标记、隐藏「设为默认」按钮）。 */
export function isDefaultModel(
  defaultModel: DefaultModel | null,
  provider: CatalogProvider | null,
  model: string,
): boolean {
  return (
    defaultModel != null &&
    provider != null &&
    defaultModel.provider === provider.provider &&
    defaultModel.model === model
  );
}
