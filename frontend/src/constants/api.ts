/**
 * @file constants/api.ts
 * API 相关共享常量：请求前缀 BASE、设定类型枚举 SETTING_TYPES（「常量即类型」的单一事实来源，
 * types/api.ts 的 SettingType 直接由它推导）、伏笔类型中文标签 LEDGER_TYPE_LABELS。
 */
import type { LedgerType } from "@/types/api";

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

/** 伏笔类型 → 中文标签（账本列表/筛选下拉展示）。 */
export const LEDGER_TYPE_LABELS: Record<LedgerType, string> = {
  setup: "埋设伏笔",
  thread: "线索推进",
  character_state: "角色状态",
  location_state: "地点状态",
  unresolved_hook: "未解钩子",
};
