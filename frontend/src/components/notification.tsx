/**
 * @file notification.tsx
 * 全局 Notification 通知：右上角堆叠的通知卡片，`notification.success/warning/info/error()` 命令式调用。
 * 核心机制：模块级通知队列 + 订阅发布，由根布局的 NotificationHost 挂载点渲染；
 * 支持常驻/自动消失、点击跳转、操作区，按 id 关闭或静默移除。
 * 分工：notification=右上角通知（跨页/后台任务/其它小说的确认提醒，信息量大、可点击跳转）；
 * message=居中靠上的轻量消息（当前页操作结果）——两套组件不要混用。
 */
"use client";

/**
 * 全局 Notification 通知（参照 Element Plus 的 ElNotification 语义）：
 * - 悬浮在页面右上角，多条自上而下堆叠；
 * - 通过 `notification.success/warning/info/error(options)` 调用；
 * - 支持标题 + 多行描述（可换行）、可关闭、默认数秒后自动消失；
 * - 组件功能参考 Element Plus：带标题的右侧弹出通知，比 Message 信息量更大。
 *
 * 与居中靠上的 Message（消息提示）是两个不同的东西，不要混用。
 */
import { useEffect, useState } from "react";
import type { NotificationOptions, NotificationType } from "@/types/ui";
export type { NotificationOptions, NotificationType };

interface NotificationItem extends NotificationOptions {
  id: number;
  type: NotificationType;
}

/** 通知自增 id：用于 React key 与按 id 关闭/移除定位。 */
let seq = 0;
/** 当前展示中的通知队列（模块级：全局 API 写入、挂载点读取，跨组件共享）。 */
let items: NotificationItem[] = [];
/** 订阅者集合：NotificationHost 挂载点订阅队列变化以重渲染。 */
const listeners = new Set<() => void>();

/** 通知所有订阅者：队列已变化。 */
function emit() {
  listeners.forEach((l) => l());
}

/** 入队一条通知并返回其 id（供调用方按 id 关闭/移除）。 */
function push(type: NotificationType, options: NotificationOptions = {}): number {
  const item: NotificationItem = {
    id: ++seq,
    type,
    ...options,
    duration: options.duration ?? 4500,
    closable: options.closable ?? true, // 关闭按钮默认显示（手动 ✕）；显式传 false 才隐藏
  };
  items = [...items, item];
  emit();
  return item.id;
}

/** 关闭通知（触发 onClose 回调），右上角 ✕ 按钮与自动消失走这里。 */
export function closeNotification(id: number) {
  const target = items.find((i) => i.id === id);
  if (!target) return;
  items = items.filter((i) => i.id !== id);
  emit();
  target.onClose?.();
}

/** 直接移除通知（不触发 onClose）：用于组件卸载/切页时隐藏，不误判为"用户已关闭"。 */
export function removeNotification(id: number) {
  items = items.filter((i) => i.id !== id);
  emit();
}

/** 关闭全部通知（Element Plus 的 notification.closeAll）。 */
export function closeAllNotifications() {
  items = [];
  emit();
}

/** 全局 Notification 通知 API。 */
export const notification = {
  success: (options: NotificationOptions) => push("success", options),
  warning: (options: NotificationOptions) => push("warning", options),
  info: (options: NotificationOptions) => push("info", options),
  error: (options: NotificationOptions) => push("error", options),
};

/** 每种通知类型的配色：延续「成功=竹青 / 警告=赭石 / 失败=朱砂」方案。 */
const TYPE_CLS: Record<NotificationType, { wrap: string; icon: string; title: string; mark: string }> = {
  success: {
    wrap: "border-emerald-300 bg-emerald-50/95 dark:border-emerald-900 dark:bg-emerald-950/95",
    icon: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
    title: "text-emerald-800 dark:text-emerald-200",
    mark: "✓",
  },
  warning: {
    wrap: "border-amber-300 bg-amber-50/95 dark:border-amber-900 dark:bg-amber-950/95",
    icon: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    title: "text-amber-800 dark:text-amber-200",
    mark: "!",
  },
  info: {
    wrap: "border-zinc-300 bg-zinc-50/95 dark:border-zinc-700 dark:bg-zinc-900/95",
    icon: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
    title: "text-zinc-700 dark:text-zinc-200",
    mark: "i",
  },
  error: {
    wrap: "border-red-300 bg-red-50/95 dark:border-red-900 dark:bg-red-950/95",
    icon: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
    title: "text-red-800 dark:text-red-200",
    mark: "✕",
  },
};

/** 单条通知卡片：标题 + 描述 + 可选操作区 + 自动消失计时；设置了 onClick 时整卡可点击跳转。 */
function NotificationCard({ item }: { item: NotificationItem }) {
  // 自动消失：duration=0 表示常驻（需手动关闭）
  useEffect(() => {
    if (!item.duration) return;
    const t = setTimeout(() => closeNotification(item.id), item.duration);
    return () => clearTimeout(t);
  }, [item.id, item.duration]);

  const c = TYPE_CLS[item.type];
  const clickable = typeof item.onClick === "function";
  return (
    <div
      className={`rise pointer-events-auto flex w-[20rem] max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-lg border px-3.5 py-3 shadow-book backdrop-blur ${
        clickable ? "cursor-pointer transition-colors hover:brightness-[0.98] dark:hover:brightness-110" : ""
      } ${c.wrap}`}
      role={clickable ? "button" : "status"}
      title={clickable ? "点击前往确认" : undefined}
      onClick={
        clickable
          ? (e) => {
              // 点击卡片 = 前往处理：仅收起卡片并执行跳转回调，不触发 onClose
              //（onClose 语义为「用户明确放弃」，如确认提醒的 ✕ = 跳过确认点；点击跳转≠放弃）
              e.stopPropagation();
              removeNotification(item.id);
              item.onClick?.();
            }
          : undefined
      }
    >
      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${c.icon}`}>
        {c.mark}
      </span>
      <div className="min-w-0 flex-1">
        {item.title != null && <div className={`text-xs font-semibold leading-5 ${c.title}`}>{item.title}</div>}
        {item.message != null && (
          <div className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-zinc-600 opacity-90 dark:text-zinc-300">
            {item.message}
          </div>
        )}
        {item.actions != null && (
          <div className="mt-1.5 flex items-center gap-1.5 border-t border-black/5 pt-1.5 dark:border-white/10">
            {item.actions}
          </div>
        )}
      </div>
      {item.closable && (
        <button
          type="button"
          aria-label="关闭通知"
          onClick={(e) => {
            e.stopPropagation();
            closeNotification(item.id);
          }}
          className="-mr-1 -mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-xs leading-none text-zinc-500 opacity-60 transition-opacity hover:opacity-100 dark:text-zinc-400"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * Notification 挂载点：渲染在根布局，收集模块级通知并悬浮在页面右上角。
 * 容器 pointer-events-none（空白处点击穿透页面），每条通知内部 pointer-events-auto（可点关闭）。
 */
export function NotificationHost() {
  const [list, setList] = useState<NotificationItem[]>(items);

  useEffect(() => {
    const l = () => setList(items);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed right-3 top-14 z-[120] flex flex-col items-end gap-2.5">
      {list.map((item) => (
        <NotificationCard key={item.id} item={item} />
      ))}
    </div>
  );
}
