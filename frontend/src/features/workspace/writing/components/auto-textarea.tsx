/**
 * @file writing/auto-textarea.tsx
 * 自动增高文本框：高度跟随内容，封顶后内部滚动（用于「本章大纲目标」等长文本输入）。
 * - 默认 maxHeight 固定上限；
 * - fill 模式：上限 = 最近滚动容器的「剩余高度」（容器可视高 − 输入框之外固定内容高），
 *   内容多时可长满剩余空间，不在底部留下大片空白。
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
  fill = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  /** 固定高度上限（px）；fill 模式下被「容器剩余高度」覆盖 */
  maxHeight?: number;
  disabled?: boolean;
  /** 高度上限自适应容器剩余空间：向上找最近的滚动容器，以「容器可视高 − 输入框之外固定内容高」
   *  为上限（内容多时可长满剩余空间，不再因固定上限而留下大片空白）。需外层处于滚动容器内。 */
  fill?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    /** 找最近的滚动容器（overflow-y 为 auto/scroll 的祖先），输入框的可用空间以它为边界 */
    const findScrollContainer = (): HTMLElement | null => {
      let node = el.parentElement;
      while (node) {
        const oy = getComputedStyle(node).overflowY;
        if (oy === "auto" || oy === "scroll") return node;
        node = node.parentElement;
      }
      return null;
    };
    const container = fill ? findScrollContainer() : null;
    const apply = () => {
      el.style.height = "auto";
      let maxH = maxHeight;
      if (container) {
        // 度量容器 = 输入框向上最后一个 overflow:visible 的祖先（表单内容层）：
        // 滚动容器的 scrollHeight 在内容不满时会被钳制为 clientHeight，不能用来算固定内容高；
        // 内容层是 visible，scrollHeight 即内容实际总高。
        let contentEl: HTMLElement | null = null;
        let n = el.parentElement as HTMLElement | null;
        while (n && n !== container && getComputedStyle(n).overflowY === "visible") {
          contentEl = n;
          n = n.parentElement as HTMLElement | null;
        }
        const contentH = contentEl ? contentEl.scrollHeight : container.scrollHeight;
        // 输入框之外的固定内容高 = 内容总高 − 输入框占的布局高度（offsetHeight，非内容 scrollHeight）
        const fixed = contentH - el.offsetHeight;
        const padBottom = parseFloat(getComputedStyle(container).paddingBottom) || 0;
        // 上限 = 容器可视高 − 底部 padding − 固定内容 − 余量：内容多时输入框恰好长满剩余空间
        maxH = Math.max(80, container.clientHeight - padBottom - fixed - 8);
      }
      // border-box 修正：style.height 含 border 而 scrollHeight 只测内容+padding，
      // 补上 border 高度让内容区恰好等于 scrollHeight，空内容时不出现滚动条
      const border = el.offsetHeight - el.clientHeight;
      el.style.height = `${Math.min(el.scrollHeight + border, maxH)}px`;
    };
    apply();
    if (!container) return;
    // 容器尺寸变化（弹窗展开/窗口缩放）时重算上限
    const ro = new ResizeObserver(apply);
    ro.observe(container);
    return () => ro.disconnect();
  }, [value, maxHeight, fill]);
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
