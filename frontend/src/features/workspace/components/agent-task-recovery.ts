/**
 * @file workspace/components/agent-task-recovery.ts
 * 工作台级 AI 任务恢复协调器：小说工作台只查询一个统一接口，按 agent 分发运行中任务，
 * 页面切换或过程弹窗关闭不影响后台任务；各业务面板只订阅自己需要的任务。
 */
import { getRunningTasks, type AgentTaskStatus } from "@/lib/api";
import { log } from "@/lib/logging";

export interface RecoveryState {
  novelId: string | null;
  initialized: boolean;
  tasks: AgentTaskStatus[];
  /** 最近一次任务（done/error，含 error）：任务从 running 消失时，消费方据此判断是否以 error 结束 */
  recent: AgentTaskStatus | null;
}

const state: RecoveryState = { novelId: null, initialized: false, tasks: [], recent: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

function emit(): void {
  for (const listener of listeners) listener();
}

async function refresh(novelId: string): Promise<void> {
  try {
    const result = await getRunningTasks(novelId);
    if (stopped || state.novelId !== novelId) return;
    state.initialized = true;
    state.tasks = result.tasks;
    state.recent = result.recent ?? null;
    emit();
  } catch (error) {
    log.errorFrom(`恢复 AI 任务失败（novel_id=${novelId}）`, error);
    if (stopped || state.novelId !== novelId) return;
    // 查询失败不能把仍在运行的任务误判为已结束，保留上一份快照并继续重试。
    if (!state.initialized) emit();
  }
  if (!stopped && state.novelId === novelId) timer = setTimeout(() => void refresh(novelId), 1500);
}

/** 工作台挂载时启动统一任务查询；同一小说只保留一个轮询器。 */
export function startAgentTaskRecovery(novelId: string): void {
  if (!stopped && state.novelId === novelId) return;
  stopAgentTaskRecovery();
  stopped = false;
  state.novelId = novelId;
  state.initialized = false;
  state.tasks = [];
  emit();
  void refresh(novelId);
}

export function stopAgentTaskRecovery(): void {
  stopped = true;
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  state.novelId = null;
  state.initialized = false;
  state.tasks = [];
  state.recent = null;
  emit();
}

export function subscribeAgentTaskRecovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentTaskRecoverySnapshot(): RecoveryState {
  return { ...state, tasks: [...state.tasks] };
}

export function getRecoveryTask(agent: string, novelId: string): AgentTaskStatus | null {
  if (!state.initialized || state.novelId !== novelId) return null;
  return state.tasks.find((task) => task.agent === agent) ?? null;
}

/** 最近一次任务（done/error，含 error）：任务从 running 消失后消费方据此判断是否以 error 结束。 */
export function getRecoveryRecent(): AgentTaskStatus | null {
  return state.recent;
}
