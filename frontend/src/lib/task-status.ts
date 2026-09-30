/**
 * @file task-status.ts
 * 全局"运行中后台任务"共享状态：由 AgentTaskToasts 每 3 秒轮询 /stream/status 后写入，
 * 写作页等组件订阅以感知后台任务（如自动评价 critic/reviser）是否在跑，
 * 用于给「评价与优化」面板显示"评价处理中"加载态、并禁用重复手动操作（避免撞后端 409）。
 */
import type { StreamTaskInfo } from "@/types/api";

type TaskState = StreamTaskInfo | null;
let current: TaskState = null;
const listeners = new Set<() => void>();

/** 写入最新运行中任务（由 AgentTaskToasts 每次轮询后调用；无任务传 null）。 */
export function setRunningTask(task: TaskState): void {
  current = task;
  for (const l of listeners) l();
}

/** 读取当前运行中任务；无则返回 null（useSyncExternalStore 的快照读取函数）。 */
export function getRunningTask(): TaskState {
  return current;
}

/** 订阅运行中任务变化；返回取消订阅函数（useSyncExternalStore 的订阅函数）。 */
export function subscribeRunningTask(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
