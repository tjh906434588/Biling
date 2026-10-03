/**
 * @file writing/use-resume-agent-task.ts
 * 从工作台级任务恢复协调器订阅指定 Agent：页面挂载时恢复完整任务上下文与流式进度，
 * 页面卸载、切换 Tab 或关闭过程弹窗都不会停止后台任务；任务离开 running 后才通知业务收尾。
 */
"use client";

import { useEffect, useRef } from "react";
import {
  getAgentTaskRecoverySnapshot,
  getRecoveryTask,
  subscribeAgentTaskRecovery,
} from "../../components/agent-task-recovery";

interface UseResumeAgentTaskOptions {
  agent: string;
  novelId: string;
  onStart: (info: {
    taskId: string;
    startedAt: number;
    thinking: string;
    output: string;
    params: Record<string, unknown>;
  }) => void;
  onProgress: (info: { thinking: string; output: string }) => void;
  onEnd: () => void;
}

export function useResumeAgentTask({ agent, novelId, onStart, onProgress, onEnd }: UseResumeAgentTaskOptions) {
  const callbacks = useRef({ onStart, onProgress, onEnd });

  // 回调引用只在 effect 中同步，避免在渲染阶段读写 ref。
  useEffect(() => {
    callbacks.current = { onStart, onProgress, onEnd };
  }, [onStart, onProgress, onEnd]);

  useEffect(() => {
    let activeTaskId: string | null = null;
    let ended = false;

    const sync = () => {
      const snapshot = getAgentTaskRecoverySnapshot();
      const task = getRecoveryTask(agent, novelId);
      if (!snapshot.initialized) return;
      if (task) {
        const progress = task.progress ?? { thinking: "", draft: "" };
        if (activeTaskId !== task.id) {
          activeTaskId = task.id;
          ended = false;
          callbacks.current.onStart({
            taskId: task.id,
            startedAt: task.started_at ? new Date(task.started_at).getTime() : Date.now(),
            thinking: progress.thinking,
            output: progress.draft,
            params: task.params ?? {},
          });
        } else {
          callbacks.current.onProgress({ thinking: progress.thinking, output: progress.draft });
        }
        return;
      }
      if (activeTaskId && !ended) {
        ended = true;
        callbacks.current.onEnd();
      }
    };

    const unsubscribe = subscribeAgentTaskRecovery(sync);
    sync();
    return unsubscribe;
  }, [agent, novelId]);
}
