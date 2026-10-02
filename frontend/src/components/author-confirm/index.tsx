/**
 * @file author-confirm/index.tsx
 * 作者确认机制对外出口（barrel）：聚合 author-confirm/ 子目录（store / host / dialog / panel / notifier）。
 * 关键机制：模块级 store（跨 tab 常驻，刷新后经 GET /confirm 轮询恢复）+ SSE author_confirm
 * 事件实时推入；生成过程弹窗内嵌展示时全局弹窗自动让位，避免重复打扰。
 * 消费方沿用原路径导入，导出面不变：默认导出弹窗宿主 + store 操作 / ConfirmPanel / ConfirmNotifier。
 */
"use client";

export { default } from "./host";
export { ConfirmPanel } from "./panel";
export { ConfirmNotifier } from "./notifier";
export {
  subscribeAuthorConfirms,
  getAuthorConfirms,
  pushAuthorConfirm,
  removeConfirm,
  subscribeInlineHosts,
  getInlineHostCount,
  setInlineHost,
  restoreAuthorConfirms,
} from "./store";