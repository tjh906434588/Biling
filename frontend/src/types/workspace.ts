/**
 * @file types/workspace.ts
 * 工作台共享类型：tab 枚举与相关配置类型。
 * 原定义在 app/workspace/[id]/page.tsx 内，重构时抽到 types/ 目录，
 * 供工作台页面与 constants/meta.ts（GUIDE_STEPS）等共享引用，避免类型漂移。
 */

/** 工作台功能区 tab 枚举：与侧栏导航/URL tab 参数一一对应。 */
export type Tab =
  | "write"
  | "settings"
  | "outline"
  | "ledger"
  | "blueprint"
  | "style"
  | "detect"
  | "graph"
  | "models"
  | "tools";
