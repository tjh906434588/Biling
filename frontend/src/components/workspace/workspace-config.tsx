/**
 * @file workspace-config.tsx
 * 工作台页面共享配置（由 app/workspace/[id]/page.tsx 重构抽出）：
 * 导航分组与图标表、AI 消耗 tab 集合、tools 调试角色辅助、SSE 日志/落库候选类型。
 * 关键机制：NAV_GROUPS 是侧栏与窄屏标签条的唯一数据源（FLAT_TABS 由其展平，URL 初始 tab 校验也用）；
 * ICONS 存内联 SVG path 片段（含 JSX 元素，故本文件为 .tsx），NavIcon 按 name 查表渲染；
 * defaultForm 生成角色初始表单值（下拉框取默认项、文本留空），tools 页角色切换/初始态共用。
 */
import type { ReactNode } from "react";
import { AGENTS } from "@/constants";
import type { Tab } from "@/types/workspace";

/** 会调用 AI（消耗 Token）的 tab：只有这些页面需要显示"AI 未接入"横幅。
 *  设定/账本/关系图等纯本地功能不在此列。 */
export const AI_TABS: ReadonlySet<Tab> = new Set(["write", "outline", "blueprint", "style", "tools"]);

/* ── 导航：带图标、按流程分组，像 IDE 的活动栏 + 工具面板 ── */
export const ICONS: Record<string, ReactNode> = {
  write: <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />,
  outline: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
  blueprint: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  settings: <path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" />,
  ledger: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></>,
  style: <><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 114.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 00-3-3.02z" /></>,
  graph: <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></>,
  models: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>,
  tools: <path d="M4 17l6-6-6-6M12 19h8" />,
};

/** 侧栏导航分组：分组名 + 若干 [tab, 标签, 图标] 项 */
export const NAV_GROUPS: { label: string; items: [Tab, string, keyof typeof ICONS][] }[] = [
  {
    label: "创作",
    items: [
      ["blueprint", "蓝图", "blueprint"],
      ["write", "写作", "write"],
    ],
  },
  {
    label: "资料",
    items: [
      ["settings", "设定", "settings"],
      ["ledger", "账本", "ledger"],
      ["style", "风格", "style"],
      ["graph", "人物关系", "graph"],
    ],
  },
  {
    label: "工具",
    items: [
      ["outline", "细化大纲", "outline"],
      ["models", "AI 设置", "models"],
    ],
  },
];
/** 展平后的全部导航项（窄屏横向标签条直接遍历渲染） */
export const FLAT_TABS = NAV_GROUPS.flatMap((g) => g.items);

/** 角色 key 列表（tools 页角色选择栏的渲染顺序） */
export const AGENT_KEYS = Object.keys(AGENTS);

/** 生成某角色的初始表单值：文本类留空，下拉框取默认选中项 */
export function defaultForm(agent: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const p of AGENTS[agent].params) {
    obj[p.key] = p.type === "select" ? String(p.default ?? "") : "";
  }
  return obj;
}

/** SSE 事件日志条目（tools 页「事件流」面板的数据源） */
export interface LogItem {
  id: number;
  event: string;
  data: string;
  kind: "info" | "ok" | "err" | "delta";
}

/** tools 调试页「加入正式库」的候选产出条目（source 缺省表示单包产出） */
export interface CommitItem {
  source?: string;
  output: Record<string, unknown>;
}
