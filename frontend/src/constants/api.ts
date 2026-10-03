/**
 * @file constants/api.ts
 * API 相关共享常量：请求前缀 BASE、设定类型枚举 SETTING_TYPES（「常量即类型」的单一事实来源，
 * types/api.ts 的 SettingType 直接由它推导）、伏笔类型中文标签（已迁移为枚举字典，见 loadLedgerTypeLabels）。
 */
import { loadMetaDict } from "@/lib/meta-dict";

/** 请求前缀：直接走 Next.js rewrite 代理（/api/* → 后端 8000）。 */
export const BASE = "/api";

/** 设定类型枚举：character=角色 | location=地点 | faction=势力 | world_rule=世界规则 | item=物品 | concept=概念。
 *  注意：types/api.ts 的 SettingType 由本常量推导，新增类型时改这里即可。 */
export const SETTING_TYPES = [
  "character",
  "location",
  "faction",
  "world_rule",
  "item",
  "concept",
] as const;

/** 拉取伏笔类型中文标签（后端 meta.py 单一源，统一缓存）；失败回退空映射（显示原始 value）。 */
export async function loadLedgerTypeLabels(): Promise<Record<string, string>> {
  try {
    const list = await loadMetaDict<{ value: string; label: string }[]>("ledger_types");
    return Object.fromEntries(list.map((l) => [l.value, l.label]));
  } catch {
    return {};
  }
}
