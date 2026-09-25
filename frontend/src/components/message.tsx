"use client";

/**
 * 全局 Message 消息提示（参照 Element Plus 的 ElMessage 语义）：
 * - 悬浮在页面正上方（居中靠上）；
 * - 通过 `message.success/warning/info/error(content, options?)` 调用；
 * - 多条同时存在时自上而下堆叠，最新一条排在下边；
 * - 默认数秒后自动消失，可配置时长/是否可关闭/关闭回调；
 * - 组件功能参考 Element Plus：轻量、全局 API、自动消失、不影响页面点击（空白区域可穿透）。
 *
 * 与右上角 Notification（通知）是两个不同的东西，不要混用。
 */
import { useEffect, useState, type ReactNode } from "react";

export type MessageType = "success" | "warning" | "info" | "error";

export interface MessageOptions {
  /** 自动消失时长（ms），默认 3000；传 0 表示不自动消失 */
  duration?: number;
  /** 是否显示关闭按钮，默认 true */
  closable?: boolean;
  /** 消失（自动或手动关闭）后回调 */
  onClose?: () => void;
}

interface MessageItem extends MessageOptions {
  id: number;
  type: MessageType;
  content: ReactNode;
}

let seq = 0;
let items: MessageItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function push(type: MessageType, content: ReactNode, options: MessageOptions = {}): () => void {
  // 同内容去重：相同 (type, content) 的消息已在展示时不重复入列。
  // 典型场景：dev 模式 StrictMode 下组件 effect 双执行（如蓝图面板 mount 时加载两次），
  // 同一请求失败会把同一个错误弹两遍；去重后只显示一条。
  const existing = items.find((i) => i.type === type && i.content === content);
  if (existing) {
    return () => dismiss(existing.id);
  }
  // 默认 3 秒自动消失（与 Element Plus 默认一致）；显式传 0 才表示常驻
  const item: MessageItem = { id: ++seq, type, content, ...options, duration: options.duration ?? 3000 };
  items = [...items, item];
  emit();
  return () => dismiss(item.id);
}

function dismiss(id: number) {
  const target = items.find((i) => i.id === id);
  if (!target) return;
  items = items.filter((i) => i.id !== id);
  emit();
  target.onClose?.();
}

/** 关闭全部消息（Element Plus 的 message.closeAll）。 */
export function closeAllMessages() {
  items = [];
  emit();
}

/** 全局 Message 消息提示 API。 */
export const message = {
  success: (content: ReactNode, options?: MessageOptions) => push("success", content, options),
  warning: (content: ReactNode, options?: MessageOptions) => push("warning", content, options),
  info: (content: ReactNode, options?: MessageOptions) => push("info", content, options),
  error: (content: ReactNode, options?: MessageOptions) => push("error", content, options),
};

/** 每条消息的配色：延续现有「成功=竹青 / 警告=赭石 / 失败=朱砂」方案。 */
const TYPE_CLS: Record<MessageType, { wrap: string; icon: string; mark: string }> = {
  success: {
    wrap: "border-emerald-300 bg-emerald-50/95 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/95 dark:text-emerald-200",
    icon: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
    mark: "✓",
  },
  warning: {
    wrap: "border-amber-300 bg-amber-50/95 text-amber-800 dark:border-amber-900 dark:bg-amber-950/95 dark:text-amber-200",
    icon: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    mark: "!",
  },
  info: {
    wrap: "border-zinc-300 bg-zinc-50/95 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-300",
    icon: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
    mark: "i",
  },
  error: {
    wrap: "border-red-300 bg-red-50/95 text-red-700 dark:border-red-900 dark:bg-red-950/95 dark:text-red-300",
    icon: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
    mark: "✕",
  },
};

function MessageCard({ item }: { item: MessageItem }) {
  // 自动消失：duration=0 表示常驻（需手动关闭）
  useEffect(() => {
    if (!item.duration) return;
    const t = setTimeout(() => dismiss(item.id), item.duration);
    return () => clearTimeout(t);
  }, [item.id, item.duration]);

  const c = TYPE_CLS[item.type];
  return (
    <div
      className={`rise pointer-events-auto flex max-w-[85vw] items-center gap-2 rounded-lg border px-4 py-2 text-sm shadow-book backdrop-blur ${c.wrap}`}
      role="status"
    >
      <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${c.icon}`}>
        {c.mark}
      </span>
      <span className="min-w-0 leading-5">{item.content}</span>
      {item.closable && (
        <button
          type="button"
          aria-label="关闭提示"
          onClick={() => dismiss(item.id)}
          className="-mr-1 ml-1 grid h-5 w-5 shrink-0 place-items-center rounded text-sm leading-none opacity-60 transition-opacity hover:opacity-100"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * Message 挂载点：渲染在根布局，收集模块级消息并居中悬浮在页面顶部。
 * 容器 pointer-events-none（空白处点击穿透页面），每条消息内部 pointer-events-auto（可点关闭）。
 */
export function MessageHost() {
  const [list, setList] = useState<MessageItem[]>(items);

  useEffect(() => {
    const l = () => setList(items);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed left-1/2 top-14 z-[110] flex -translate-x-1/2 flex-col items-center gap-2">
      {list.map((item) => (
        <MessageCard key={item.id} item={item} />
      ))}
    </div>
  );
}
