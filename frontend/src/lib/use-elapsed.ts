"use client";

import { useEffect, useState } from "react";

/** 进行中的已用秒数（每秒刷新一次，让用户知道 AI 确实在工作）。 */
export function useElapsed(active: boolean, startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, startedAt]);
  return active && startedAt != null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}
