/**
 * @file components/global-logging.tsx
 * 全局前端日志初始化宿主：随根布局挂载一次，捕获未处理错误并上报后端落盘。
 */
"use client";

import { useEffect } from "react";
import { initGlobalLogging } from "@/lib/logging";

export default function GlobalLogging() {
  useEffect(() => {
    initGlobalLogging();
  }, []);
  return null;
}
