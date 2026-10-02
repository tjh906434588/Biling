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
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
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
