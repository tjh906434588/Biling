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
import { useEffect, useState, type ReactNode } from "react";

export type NotificationType = "success" | "warning" | "info" | "error";

export interface NotificationOptions {
  /** 标题（加粗主行，可多行文本） */
  title?: ReactNode;
  /** 描述正文（位于标题下方，可多行换行） */
  message?: ReactNode;
  /** 自动消失时长（ms），默认 4500；传 0 表示不自动消失 */
  duration?: number;
  /** 是否显示右上角关闭按钮，默认 true */
  closable?: boolean;
  /** 消失（自动或手动关闭）后回调 */
  onClose?: () => void;
  /** 点击通知卡片触发（如跳转到对应小说工作台）；设置后整张卡片可点击 */
  onClick?: () => void;
}

interface NotificationItem extends NotificationOptions {
  id: number;
  type: NotificationType;
}

let seq = 0;
let items: NotificationItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

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
              // 点击卡片 = 确认前往：关闭通知并执行跳转回调
              e.stopPropagation();
              closeNotification(item.id);
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
