/**
 * @file notifier.tsx
 * 全局作者确认提醒中心（挂载在根布局，不依赖任何小说上下文）。
 * 关键机制：跨小说轮询所有待确认请求——确认属于「当前工作台小说」→ 直接推入 store 弹窗（自动弹确认）；
 * 属于「其他小说」→ 右上角常驻 Notification，写明《书名》+ 哪个功能需要确认，点击跳转到对应小说工作台；
 * 状态由后端 author_confirms 表持久化（刷新/关闭页面重开，轮询一发现就再次提醒，不会丢）；
 * 已答复 / 跳过的确认自动收回通知与弹窗。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { notification, removeNotification } from "../../notification";
import {
  dismissAuthorConfirm,
  fetchPendingConfirms,
  type AuthorConfirm,
} from "@/lib/api";
import { getAgentLabel, CONFIRM_POLL_INTERVAL } from "@/constants";
import { pushAuthorConfirm } from "./store";

/**
 * 全局作者确认提醒中心（挂载在根布局，不依赖任何小说上下文）：
 * - 跨小说轮询所有待确认请求，无论作者正在哪部小说/哪个页面；
 * - 确认属于「当前工作台小说」→ 直接推入弹窗 store（自动弹确认）；
 * - 确认属于「其他小说」→ 右上角常驻 Notification，写明《书名》+ 哪个功能需要确认，
 *   点击即跳转到对应小说工作台（进入后由上面的弹窗宿主自动弹出确认）；
 * - 状态由后端 author_confirms 表持久化：刷新 / 关闭页面重开，轮询一发现就再次提醒，不会丢；
 * - 已答复 / 跳过的确认自动收回通知与弹窗。
 */
export function ConfirmNotifier() {
  const pathname = usePathname();
  const router = useRouter();
  // 当前工作台小说 id（从 /workspace/[id] 路径解析；null = 不在工作台页面）
  const [currentNovel, setCurrentNovel] = useState<string | null>(null);
  /** confirm id → 已弹出的右上角通知 id（其他小说；防止每轮重复提醒，用户手动关掉则不再弹） */
  const notifiedRef = useRef(new Map<string, number>());
  /** 记录在 store 里弹过窗的确认 id：切换小说后再回来时不需要再次推入（弹窗宿主自己会恢复） */
  const modalPushedRef = useRef(new Set<string>());

  // 从 /workspace/[id] 提取当前工作台小说
  useEffect(() => {
    const m = pathname?.match(/^\/workspace\/([^/?]+)/);
    setCurrentNovel(m?.[1] ?? null);
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      let items: AuthorConfirm[];
      try {
        items = await fetchPendingConfirms();
      } catch {
        return; // 后端未就绪/网络抖动：静默，下轮再试
      }
      if (cancelled) return;

      const pendingIds = new Set(items.map((i) => i.id));

      // 已不在待确认列表的：收回对应通知（答复/跳过/超时）
      for (const [id, nid] of Array.from(notifiedRef.current.entries())) {
        if (!pendingIds.has(id)) {
          removeNotification(nid);
          notifiedRef.current.delete(id);
        }
      }

      for (const it of items) {
        if (it.novel_id === currentNovel) {
          // 当前工作台小说：交给弹窗宿主（实时 SSE 已推、切回时这里兜底恢复）
          if (!modalPushedRef.current.has(it.id)) {
            modalPushedRef.current.add(it.id);
            pushAuthorConfirm(it);
          }
          // 若此前因在别处弹过右上角通知，切回来后收掉，改由弹窗承担
          const nid = notifiedRef.current.get(it.id);
          if (nid != null) {
            removeNotification(nid);
            notifiedRef.current.delete(it.id);
          }
        } else if (!notifiedRef.current.has(it.id)) {
          // 其他小说：右上角常驻提醒，写明书名 + 哪个功能，点击跳转确认
          const label = getAgentLabel(it.agent);
          const nid = notification.warning({
            title: `《${it.novel_title ?? "未命名小说"}》需要你确认`,
            message: `${label}生成到这里，需要你拿主意：\n${it.question}`,
            duration: 0, // 常驻，直到作者去确认、主动跳过或确认被作废
            onClick: () => router.push(`/workspace/${it.novel_id}`),
            // 点 ✕ = 放弃此确认：通知后端跳过（解除等待），否则轮询每几秒会把它重新弹回来
            onClose: () => {
              void dismissAuthorConfirm(it.id).catch(() => {});
              notifiedRef.current.delete(it.id);
            },
          });
          notifiedRef.current.set(it.id, nid);
        }
      }
    };

    void poll();
    const timer = setInterval(poll, CONFIRM_POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentNovel, router]);

  return null;
}
