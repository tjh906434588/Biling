/**
 * @file writing/use-resume-agent-task.ts
 * 「刷新/切页后恢复进行中 AI 任务」通用 hook（从 writing-panel.tsx 三段几乎相同的
 * novelist/reviser/critic 轮询 effect 收敛而来，行为完全不变）：
 * 进入页面时查询后端 agent_tasks，若该小说对应 agent 仍在运行，则恢复「进行中」状态
 * （onStart 拿到后端累积的流式文字与真实开始时间，刷新前已流出的内容不丢）并每 1.5s 轮询，
 * 期间 onProgress 更新流式文字（不重置开始时间），直到任务结束回调 onEnd 复位状态。
 * 完成通知与数据刷新由全局 AgentTaskToasts（biling:agent-task-done）负责。
 */
"use client";

import { useEffect } from "react";
import { getAgentRunningTask } from "@/lib/api";

interface UseResumeAgentTaskOptions {
  agent: "novelist" | "reviser" | "critic";
  novelId: string;
  /** 查询到任务仍在运行时，恢复「进行中」状态（含任务真实开始时间）。 */
  onStart: (info: { startedAt: number; thinking: string; output: string }) => void;
  /** 轮询期间更新流式文字（仅文字，不改开始时间）。 */
  onProgress: (info: { thinking: string; output: string }) => void;
  /** 轮询到任务结束（成功/失败均触发）后复位状态。 */
  onEnd: () => void;
}

export function useResumeAgentTask({ agent, novelId, onStart, onProgress, onEnd }: UseResumeAgentTaskOptions) {
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let r: Awaited<ReturnType<typeof getAgentRunningTask>>;
      try {
        r = await getAgentRunningTask(agent, novelId);
      } catch {
        return; // 查询失败：不强行恢复
      }
      if (stopped || !r.running || !r.task) return;
      const task = r.task;
      // 恢复进行中状态：用后端累积的流式文字与任务真实开始时间（刷新前已流出的内容不丢）
      onStart({
        startedAt: task.started_at ? new Date(task.started_at).getTime() : Date.now(),
        thinking: task.progress?.thinking ?? "",
        output: task.progress?.draft ?? "",
      });
      // 轮询到任务结束（成功/失败均退出）
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let r2: Awaited<ReturnType<typeof getAgentRunningTask>>;
        try {
          r2 = await getAgentRunningTask(agent, novelId);
        } catch {
          break; // 查询失败：停止轮询，不再强行维持「进行中」
        }
        if (r2.running && r2.task) {
          const p = r2.task.progress;
          if (p) onProgress({ thinking: p.thinking, output: p.draft });
          continue;
        }
        break;
      }
      if (!stopped) onEnd();
    })();
    return () => {
      stopped = true;
    };
    // onStart/onProgress/onEnd 由调用方以内联闭包传入（每次渲染重建），其行为只由调用方 state 决定；
    // 本 hook 只在 novelId 变化时重新挂载，与三段原始 effect 的依赖一致
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId]);
}
