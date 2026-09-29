/**
 * @file use-elapsed.ts
 * 进行中的已用秒数 Hook：每秒刷新一次，让用户知道 AI 确实在工作。
 * 核心机制：active 且 startedAt 非空时启动 setInterval，每秒更新本地 now 时间戳，
 * 用 now - startedAt 换算已用秒数；未激活或未开始时返回 0 且不启动定时器。
 */
"use client";

import { useEffect, useState } from "react";

/**
 * 计算「进行中」任务的已用秒数。
 * @param active 是否处于运行中（非运行不启动定时器，返回 0）
 * @param startedAt 开始时间戳（ms）；null 表示尚未开始
 * @returns 已用秒数（>=0，向下取整）；未激活/未开始时为 0
 */
export function useElapsed(active: boolean, startedAt: number | null): number {
  // 本地「当前时刻」状态：由定时器驱动刷新，不依赖全局时钟
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt == null) return;
    // 激活瞬间立即刷新一次，避免首帧显示上一次的旧秒数
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, startedAt]);
  return active && startedAt != null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}
