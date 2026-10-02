/**
 * @file first-run-guide.tsx
 * 首次进入工作台的路径引导：右上角 Notification（常驻，duration=0）。
 * 关键机制：localStorage 记已读（biling.wsGuide.{novelId}）；仅用户手动 ✕ 才标记已读，
 * 离开工作台路由隐藏不标记、回来重新展示；点步骤按钮经 onGo 切 tab，通知保持常驻不关闭。
 * 本组件由工作台页在主画布内挂载，切 tab 常驻。
 */
"use client";

import { useEffect, useRef } from "react";
import { GUIDE_STEPS } from "@/constants";
import type { Tab } from "@/types/workspace";
import { notification, removeNotification } from "@/components/notification";

export default function FirstRunGuide({ novelId, onGo }: { novelId: string; onGo: (t: Tab) => void }) {
  const notifIdRef = useRef<number | null>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(`biling.wsGuide.${novelId}`) === "1";
    } catch {
      /* 隐私模式下默认展示 */
    }
    if (seen) return;

    notifIdRef.current = notification.info({
      duration: 0, // 常驻：只有手动 ✕ 才关闭
      title: "第一次写这本书？按这个顺序走",
      message: (
        <>
          <p className="text-[12px] leading-5 text-zinc-500 dark:text-zinc-400">
            蓝图是整本书的底稿，从设定出发定骨架；写正文前会让你先确认这一章的安排，确认后直接写作。
          </p>
          <ol className="mt-2 flex flex-col gap-1">
            {GUIDE_STEPS.map(([t, label, hint], i) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => onGo(t)}
                  title={hint}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[10px] text-white dark:bg-zinc-100 dark:text-zinc-900">
                    {i + 1}
                  </span>
                  {label}
                  <span className="ml-auto text-[11px] text-zinc-400">→</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ),
      onClose: () => {
        notifIdRef.current = null;
        // 仅用户手动 ✕ 关闭时标记已读；离开工作台页面的隐藏不算
        try {
          localStorage.setItem(`biling.wsGuide.${novelId}`, "1");
        } catch {
          /* 隐私模式下忽略 */
        }
      },
    });

    // 离开工作台页面（组件卸载）时隐藏通知，但不触发 onClose（不标记已读）；回来重新展示
    return () => {
      if (notifIdRef.current != null) {
        removeNotification(notifIdRef.current);
        notifIdRef.current = null;
      }
    };
  }, [novelId, onGo]);

  return null;
}
