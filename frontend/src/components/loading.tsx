"use client";

import type { ReactNode } from "react";

interface LoadingProps {
  /** 是否处于加载态；true 时在内容上方盖遮罩并显示转圈，同时拦截一切点击 */
  loading: boolean;
  /** 加载提示文字 */
  text?: string;
  children: ReactNode;
  /** 弹窗等小容器内使用：更轻的半透明遮罩（不模糊），避免盖住整个页面背景 */
  inset?: boolean;
  /** 传给外层定位容器的额外类名（如撑满父容器时传 flex-1 min-h-0） */
  className?: string;
}

/**
 * 全站统一加载遮罩（功能参考 Element UI 的 Loading）：
 * - 数据未就绪时，在容器上方盖一层半透明遮罩 + 居中旋转图标，天然拦截点击；
 * - 数据加载完成后解除遮罩，内容恢复正常可交互。
 * 用法：<Loading loading={loading}>内容</Loading>。
 */
export default function Loading({
  loading,
  text = "加载中…",
  inset = false,
  className,
  children,
}: LoadingProps) {
  return (
    <div className={`relative ${className ?? ""}`}>
      {children}
      {loading && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 z-30 grid place-items-center"
        >
          <div
            className={`absolute inset-0 ${
              inset
                ? "bg-white/50 dark:bg-zinc-900/60"
                : "bg-white/60 backdrop-blur-[2px] dark:bg-zinc-900/65"
            }`}
          />
          <div className="relative flex flex-col items-center gap-2.5">
            <svg aria-hidden viewBox="0 0 24 24" fill="none" className="h-7 w-7 animate-spin text-seal">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{text}</span>
          </div>
        </div>
      )}
    </div>
  );
}
