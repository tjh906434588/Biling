"use client";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** 悬停弹层里的解释内容 */
  children: ReactNode;
  /** 弹层相对问号图标展开的方向：bottom=下方（默认）、right=右侧（侧栏按钮用）、top=上方、left=左侧 */
  side?: "bottom" | "right" | "top" | "left";
  /** 兼容旧接口：right=弹层与图标右侧对齐（默认）、left=与左侧对齐。 */
  align?: "left" | "right";
  /** 弹层宽度（Tailwind 类），默认 w-64 */
  width?: string;
  /** 兼容旧接口：现在无论传不传都固定渲染到 body（fixed 定位），避免被容器 overflow 裁剪/挤压错位。 */
  portal?: boolean;
}

/**
 * InfoTip：问号图标 + 悬停出解释。
 * 弹层始终用 createPortal 渲染到 body、并按图标实际位置 fixed 定位：
 * 图标本身永远不会因为弹层出现而移动，弹层也不会被按钮/容器 overflow 裁剪、或盖住按钮内容。
 * 用法：
 *   <InfoTip>这里放解释文字（支持 JSX）</InfoTip>
 *   <InfoTip side="right">按钮在侧栏时，向右侧展开</InfoTip>
 */
export default function InfoTip({ children, side = "bottom", align = "right", width = "w-64" }: Props) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => setMounted(true), []);

  const show = () => setOpen(true);
  const hide = () => {
    setOpen(false);
    setPos(null);
  };

  // 打开期间页面滚动 / 视口变化 → 关闭，避免 fixed 定位的弹层留在原地错位
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  // 弹层挂载后按图标真实位置计算坐标（fixed 定位到 body），并做视口边缘收敛
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const el = triggerRef.current;
    const tip = tipRef.current;
    if (!el || !tip) return;
    const rect = el.getBoundingClientRect();
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const gap = 8;
    const pad = 8;
    let top = 0;
    let left = 0;
    if (side === "right") {
      left = rect.right + gap;
      top = align === "left" ? rect.bottom - tipH : rect.top;
    } else if (side === "left") {
      left = rect.left - gap - tipW;
      top = align === "left" ? rect.bottom - tipH : rect.top;
    } else if (side === "top") {
      top = rect.top - gap - tipH;
      left = align === "right" ? rect.right - tipW : rect.left;
    } else {
      top = rect.bottom + gap;
      left = align === "right" ? rect.right - tipW : rect.left;
    }
    // 视口边缘收敛，避免弹层跑出屏幕
    left = Math.max(pad, Math.min(left, window.innerWidth - tipW - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - tipH - pad));
    setPos({ top, left });
  }, [open, mounted, side, align]);

  const tooltip =
    mounted && open
      ? createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className={`pointer-events-none fixed z-[200] rounded-lg border border-zinc-200 bg-white p-3 text-[11px] leading-5 text-zinc-500 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 ${width} ${
              pos ? "" : "invisible"
            }`}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0 }}
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span
        aria-hidden
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-zinc-300 text-[10px] leading-none text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-600 dark:border-zinc-600 dark:hover:border-zinc-400 dark:hover:text-zinc-300"
      >
        ?
      </span>
      {tooltip}
    </span>
  );
}
