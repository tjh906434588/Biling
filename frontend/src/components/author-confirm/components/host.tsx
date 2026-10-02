/**
 * @file host.tsx
 * 全局作者确认弹窗宿主：挂在工作台根（AgentTaskToasts 旁），跨 tab 常驻。
 * 关键机制：订阅 store 的待确认队列与内嵌宿主计数；当前小说已有「生成过程弹窗」在运行时让位
 * （避免层级覆盖 / 误关其它弹窗）；首次进入/切换小说时从后端恢复待确认项（刷新后弹窗重现）。
 * 同一时间只展示最早的确认请求，已随生成弹窗内嵌展示过的跳过，答复后出队顺延展示下一条。
 */
"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  EMPTY_CONFIRM_SNAPSHOT,
  EMPTY_INLINE_SNAPSHOT,
  getAuthorConfirms,
  getInlineHostCount,
  isInlineShown,
  removeConfirm,
  restoreAuthorConfirms,
  subscribeAuthorConfirms,
  subscribeInlineHosts,
} from "./store";
import { ConfirmDialog } from "./dialog";

interface AuthorConfirmHostProps {
  novelId: string;
}

/** 全局作者确认弹窗宿主：挂在工作台根（AgentTaskToasts 旁），跨 tab 常驻。
 * 若当前小说已有「生成过程弹窗」在运行（内嵌宿主），确认改由弹窗内联展示，这里让位（避免层级覆盖 / 误关其它弹窗）。 */
export default function AuthorConfirmHost({ novelId }: AuthorConfirmHostProps) {
  // 第三个参数 = 服务端快照：SSR 预渲染时队列恒为空，避免 "Missing getServerSnapshot" 报错
  const queue = useSyncExternalStore(subscribeAuthorConfirms, getAuthorConfirms, () => EMPTY_CONFIRM_SNAPSHOT);
  const inlineCount = useSyncExternalStore(subscribeInlineHosts, getInlineHostCount, () => EMPTY_INLINE_SNAPSHOT);

  // 首次进入 / 切换小说：从后端恢复待确认项（刷新后弹窗重现）
  useEffect(() => {
    void restoreAuthorConfirms(novelId);
  }, [novelId]);

  // 当前小说有生成过程弹窗正在运行：确认由弹窗内联展示，全局弹窗让位
  if ((inlineCount.get(novelId) ?? 0) > 0) return null;

  // 同一时间只展示最早的确认请求；已随生成弹窗内嵌展示过的跳过（不再单独弹，避免重复打扰），
  // 作者答复后出队，顺延展示下一条
  const confirm = queue.find((c) => !isInlineShown(c.id)) ?? null;
  return (
    <ConfirmDialog key={confirm?.id ?? "none"} confirm={confirm ?? null} onSettled={(id) => removeConfirm(id)} />
  );
}
