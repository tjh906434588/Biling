/**
 * @file agent-task-toasts.tsx
 * 全局 AI 后台任务完成通知：轮询感知后台任务结束，跨 tab 常驻提醒（挂在工作台外层）。
 * 核心机制：每 3 秒轮询 /stream/status，对比上轮与当前「运行中任务」判定完成事件；
 * 仅离开发起页或页面刚加载恢复的任务才弹通知（发起页自身 UI 不重复打扰），
 * 完成时派发 biling:agent-task-done 事件供当前面板刷新数据。
 */
"use client";

import { useEffect, useRef } from "react";
import { friendlyTaskError, getStreamStatus, type StreamStatusResult, type StreamTaskInfo } from "@/lib/api";
import { AGENT_LABELS } from "@/constants";
import { notification } from "@/components/notification";
import { message } from "@/components/message";
import { setRunningTask } from "@/lib/task-status";

/** 后台任务展示名：如「蓝图师·第 3 章」（通知标题用）。 */
function taskLabel(t: StreamTaskInfo): string {
  return `${AGENT_LABELS[t.agent] ?? t.agent}${t.chapter_no != null ? `·第 ${t.chapter_no} 章` : ""}`;
}

/**
 * 全局 AI 后台任务完成通知（挂在工作台外层，跨 tab 常驻）：
 * - 通过轮询 /stream/status 感知后台任务从"运行中 → 结束"；结束时走全局 Notification（右上角，自动消失）。
 * - 区分"发起页"：任务第一次被轮询看到时所在的 tab 记为发起页。发起页上由页面自身的生成 UI 反馈
 *   （流式正文、成功提示），这里不重复打扰；用户离开过发起页、或页面刚加载恢复后台任务时，才通知。
 * - 完成时向 window 派发 biling:agent-task-done 事件，供当前面板刷新数据。
 */
export default function AgentTaskToasts({ novelId, tab }: { novelId: string; tab: string }) {
  const prevRunningRef = useRef<StreamTaskInfo | null>(null);
  /** 已提示过"完成"的任务 id（提醒只有一次）。 */
  const doneNotified = useRef<Set<string>>(new Set());
  /** 任务第一次被轮询看到时所在的 tab（≈发起页）。 */
  const tabAtFirstSeen = useRef<Map<string, string>>(new Map());
  /** 用户是否离开过发起页：离开后发起页自身的生成 UI 已卸载，需由全局提示兜底。 */
  const switchedAway = useRef<Set<string>>(new Set());
  /** 组件是否已跑过第一轮轮询（区分"页面刚加载恢复任务"与"页内新发起任务"）。 */
  const firstPoll = useRef(true);
  /** 最近一次轮询的小说 id：切换小说时清空所有跟踪状态，避免上一部小说的任务误弹提醒。 */
  const lastNovelIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!novelId) return;
    // 换小说：上一部小说的任务不能在当前小说工作台里提醒，全部跟踪状态清空（App Router 切参不重挂载组件）
    if (lastNovelIdRef.current !== novelId) {
      lastNovelIdRef.current = novelId;
      prevRunningRef.current = null;
      doneNotified.current.clear();
      tabAtFirstSeen.current.clear();
      switchedAway.current.clear();
      firstPoll.current = true;
      setRunningTask(null); // 同步清空共享任务状态，避免上一部小说的任务状态残留到新小说面板
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      let st: StreamStatusResult;
      try {
        st = await getStreamStatus(novelId);
      } catch {
        return; // 查询失败静默，下轮再试
      }
      if (cancelled) return;

      const prev = prevRunningRef.current;
      const cur = st.running;
      prevRunningRef.current = cur;
      // 写入共享状态：写作页据此判断"评价/优化任务是否在跑"，显示加载态、禁用重复操作
      setRunningTask(cur);

      // 首轮轮询（组件刚挂载/刚切小说）即结束标记，防止把「页内新发起」的任务误判成恢复任务：
      // - 首轮就有任务在跑 = 后台恢复任务（发起页 UI 已不在），完成时需全局通知兜底；
      // - 首轮无任务、之后用户在页内新发起的任务，由发起页自身弹居中提示，这里不再重复弹右上角通知。
      if (firstPoll.current) {
        firstPoll.current = false;
        if (cur) switchedAway.current.add(cur.id);
      }

      // ── 完成：上一轮有任务、这一轮没了 → 任务结束 ──
      if (prev && !cur) {
        const info = st.recent && st.recent.id === prev.id ? st.recent : prev;
        const firstSeenTab = tabAtFirstSeen.current.get(prev.id);
        const crossPage = switchedAway.current.has(prev.id) || (firstSeenTab != null && firstSeenTab !== tab);
        // 蓝图（生成/激活）完成：用户当前在蓝图页时，由蓝图页自身的 Message（居中靠上）提示，这里不重复弹；
        // 在其他页面时由本 Notification（右上角）提示。其余 agent 仍只在离开发起页时提示。完成只提示一次。
        const isBlueprint = prev.agent === "blueprint_architect" || prev.agent === "blueprint_activation";
        // 评价/优化（critic/reviser）：发起页是写作页。完成时若用户当前在写作页，由面板/这里统一弹居中
        // Message（消息）；若用户当前在其他页面，才用右上角 Notification（通知）。与作者约定：
        // 「当前页触发的成功操作弹消息，其他页面操作完成的才弹通知」。
        const isWritingTask = prev.agent === "critic" || prev.agent === "reviser";
        const onWritingPage = isWritingTask && tab === "writing";
        const shouldNotify = isBlueprint ? tab !== "blueprint" : crossPage;
        if (!doneNotified.current.has(prev.id)) {
          doneNotified.current.add(prev.id);
          const label = taskLabel(info);
          if (shouldNotify) {
            if (info.status === "error") {
              const title = prev.agent === "blueprint_activation" ? "蓝图激活失败" : `${label} 生成失败`;
              if (onWritingPage) message.error(friendlyTaskError(info.error, title));
              else notification.error({ title, message: friendlyTaskError(info.error, undefined) });
            } else if (prev.agent === "blueprint_activation") {
              notification.success({ title: info.msg ?? "蓝图已设为生效中" });
            } else {
              // 蓝图生成：用后端落库时写入的带版本号文案（如"蓝图 v1 已生成完毕"）；跨页由 Notification 通知
              const title = isBlueprint ? (info.msg ?? "蓝图已生成完毕") : `${label} 已生成完毕，可以去看了`;
              if (onWritingPage) message.success(title);
              else notification.success({ title });
            }
          }
          // 通知当前面板：后台任务已落库，可刷新数据（如写作页章节目录）。
          // 评价/优化任务（critic/reviser）无条件派发：自动评价是写作页内发起、页内完成的，
          // crossPage 恒为 false，若沿用「仅离开发起页才派发」的逻辑，评价落库后写作页评价栏不会刷新，
          // 作者看不到结果。手动评价已由写作页自身流式收尾刷新，此处重复派发仅触发一次幂等重拉，无副作用。
          if (shouldNotify || isWritingTask) {
            window.dispatchEvent(new CustomEvent("biling:agent-task-done", { detail: { task: info } }));
          }
        }
        return;
      }

      if (!cur) return;

      // ── 进行中：记录首次被看到的页；离开过发起页则计入 switchedAway（完成时据此判断是否全局通知）──
      if (!tabAtFirstSeen.current.has(cur.id)) tabAtFirstSeen.current.set(cur.id, tab);
      if (tab !== tabAtFirstSeen.current.get(cur.id)) switchedAway.current.add(cur.id);
    };

    void poll();
    timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // 依赖 tab：切页时立即重跑一次 poll（响应更快），ref 跨重跑保留，去重逻辑不受影响
  }, [novelId, tab]);

  return null;
}
