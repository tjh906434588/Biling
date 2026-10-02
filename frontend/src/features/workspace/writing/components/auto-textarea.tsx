/**
 * @file writing/auto-textarea.tsx
 * 自动增高文本框：高度跟随内容，封顶后内部滚动（用于「本章大纲目标」等长文本输入）。
 * 纯展示组件：受控 value/onChange，由外层传入。
 */
"use client";

import { useEffect, useRef } from "react";

/** 自动增高文本框：高度跟随内容，封顶后内部滚动（用于「本章大纲目标」）。 */
export function AutoTextarea({
  value,
  onChange,
  placeholder,
  className,
  maxHeight = 320,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  maxHeight?: number;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // border-box（Tailwind preflight）下 style.height 含 border，而 scrollHeight 只测内容+padding：
    // 直接把高度设为 scrollHeight，内容区会比 scrollHeight 少 2×border 高度、恒溢出 → 空内容也出现滚动条。
    // 修正：补上 border 高度（offsetHeight - clientHeight），让内容区高度恰好等于 scrollHeight，
    // 仅当内容真的超过 maxHeight 时才出现内部滚动条。
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, maxHeight)}px`;
  }, [value, maxHeight]);
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      disabled={disabled}
    />
  );
}
