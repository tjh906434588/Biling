/**
 * @file modal.tsx
 * 全站统一 Modal 容器：遮罩 + 标题栏 + 内容区 + 可选 footer，靠上显示、标题栏可拖拽。
 * 核心机制：pointer 事件实现拖拽（带视口限位），内容区支持 fill / fullHeight / regionScroll
 * 三种高度/滚动策略。
 * 分工：Modal=通用大容器（弹窗宿主）；ConfirmDialog=轻量确认弹窗（替代原生 confirm）；
 * Message / Notification=无遮罩的悬浮提示，不走 Modal。
 */
"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

interface ModalProps {
  open: boolean;
  title: ReactNode;
  /** 标题下方的一行说明（可选） */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区（可选）；不传则无 footer。 */
  footer?: ReactNode;
  /** 宽度类，默认 max-w-lg；宽表单可用 max-w-xl / max-w-2xl。 */
  maxWidth?: string;
  /** 内容区是否撑满弹窗剩余高度：弹窗本身不滚动，内容内部自己滚动（配合子组件内部 flex 布局使用）。 */
  fill?: boolean;
  /** 弹窗固定为页面高度（100dvh - 3rem，不设 42rem 上限）；配合 flex 布局，由内容里某个区域撑满剩余高度。 */
  fullHeight?: boolean;
  /** 内容区改纵向 flex 且不整块滚动，由内容里某个区域自行滚动（该区域加 flex-1 min-h-0 overflow-y-auto）。
   *  弹窗高度仍随内容增长，顶到视口上限（max-h）后那个区域才转为内部滚动。 */
  regionScroll?: boolean;
}

/**
 * 全站统一弹窗：
 * - 靠上显示（顶部 1.5rem、底部留 1.5rem 间隔），面板 max-h = 100dvh - 3rem，
 *   默认（未拖拽时）总高不超过视口，因此外层不会出现滚动条；
 *   只有内容区内部滚动、以及拖拽移出视口时才会出现滚动。
 * - 按住标题栏可拖拽移动（pointer 事件 + 视口内保底可见的限位）。
 */
export default function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  maxWidth = "max-w-lg",
  fill = false,
  fullHeight = false,
  regionScroll = false,
}: ModalProps) {
  // 拖拽偏移量（transform 位移）；每次打开重置回初始位置
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // 弹窗面板引用：拖拽限位需要它的宽高
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 拖拽会话缓存：按下时的指针坐标 + 基准偏移，move 时据此计算增量
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // 每次打开回到顶部初始位置
  useEffect(() => {
    if (open) setOffset({ x: 0, y: 0 });
  }, [open]);

  if (!open) return null;

  /** 标题栏按下：记录拖拽起点并捕获指针（关闭按钮等交互元素除外）。 */
  function onHeaderPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // 关闭按钮等交互元素不触发拖拽
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
    e.currentTarget.setPointerCapture(e.pointerId); // 捕获指针：拖出标题栏后仍持续收到 move，直到松开
  }

  /** 拖动中：按指针增量更新偏移，并限位保证弹窗始终有一部分留在视口内。 */
  function onHeaderPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const w = panelRef.current?.offsetWidth ?? 0;
    const h = panelRef.current?.offsetHeight ?? 0;
    // 限位：保证弹窗至少有一部分留在视口内
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const x = clamp(d.baseX + (e.clientX - d.startX), -w + 120, window.innerWidth - 120);
    const y = clamp(d.baseY + (e.clientY - d.startY), -h + 60, window.innerHeight - 60);
    setOffset({ x, y });
  }

  /** 松开 / 取消指针：结束拖拽会话。 */
  function endDrag() {
    dragRef.current = null;
  }

  return (
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex min-h-full items-start justify-center px-4 pt-6">
        <div
          ref={panelRef}
          className={`my-0 flex w-full ${maxWidth} flex-col rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900 ${
            fill || fullHeight
              ? fullHeight
                ? "h-[calc(100dvh-3rem)]"
                : "h-[min(calc(100dvh-3rem),42rem)]"
              : "max-h-[calc(100dvh-3rem)]"
          }`}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        >
          <div
            className="flex shrink-0 cursor-grab touch-none select-none items-start justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 active:cursor-grabbing dark:border-zinc-700"
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
              {subtitle != null && (
                <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{subtitle}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="h-4 w-4"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div
            className={
              fill || fullHeight || regionScroll
              ? "flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4"
              : "min-h-0 flex-1 overflow-y-auto px-5 py-4"
            }
          >
            {children}
          </div>

          {footer != null && (
            <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-700">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
