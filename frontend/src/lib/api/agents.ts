/**
 * @file lib/api/agents.ts
 * AI 角色 SSE 流式接口与作者确认（/stream/agents/*）：runAgent 逐事件回调（fetch ReadableStream 手动解析 SSE）、
 * 任务持久化状态（刷新后恢复"生成中"）、待确认请求的轮询与提交。
 */
import { BASE } from "@/constants/api";
import { log } from "@/lib/logging";
import type {
  AgentRunningTaskResult,
  AuthorConfirm,
  RunningTasksResult,
  StreamEvent,
  StreamEventData,
  StreamStatusResult,
} from "@/types/api";
import { httpError } from "./errors";

/** 查询该小说全部进行中的 AI 任务，页面进入时用于统一恢复。 */
export async function getRunningTasks(novelId: string): Promise<RunningTasksResult> {
  const res = await fetch(`${BASE}/stream/agents/tasks?novel_id=${novelId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询生成任务失败");
  }
  return res.json();
}

/** 查询该小说该角色是否有进行中的生成任务（兼容旧页面恢复逻辑）。 */
export async function getAgentRunningTask(
  agent: string,
  novelId: string,
): Promise<AgentRunningTaskResult> {
  const res = await fetch(`${BASE}/stream/agents/${agent}/tasks?novel_id=${novelId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询生成任务失败");
  }
  return res.json();
}

/** 查询该小说最近的 AI 生成任务（含进行中/刚完成）：刷新或切页回来后恢复状态用。 */
export async function getStreamStatus(novelId: string): Promise<StreamStatusResult> {
  const res = await fetch(`${BASE}/stream/agents/status?novel_id=${novelId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询生成任务失败");
  }
  return res.json();
}

/**
 * 查询待作者确认的请求。
 * - 传 novelId：只查该小说（刷新后恢复当前工作台弹窗）；
 * - 不传：返回所有小说的待确认项（全局确认提醒中心跨小说轮询，用于"不在对应工作台也要提醒"）。
 * agent 传入时精确到角色。
 */
export async function fetchPendingConfirms(novelId?: string, agent?: string): Promise<AuthorConfirm[]> {
  const q = new URLSearchParams();
  if (novelId) q.set("novel_id", novelId);
  if (agent) q.set("agent", agent);
  const res = await fetch(`${BASE}/stream/agents/confirm?${q}`);
  if (!res.ok) throw new Error("查询作者确认请求失败");
  const data = await res.json();
  return (data.items ?? []) as AuthorConfirm[];
}

/**
 * 提交作者确认：answer 为选项 id / 自定义文本 / __regenerate__ / __fields__；
 * note 为可选补充说明；fieldAnswers 为场景卡片确认的字段答案（字段 → 选定文本）。
 */
export async function submitAuthorConfirm(
  confirmId: string,
  answer: string,
  note?: string,
  fieldAnswers?: Record<string, string>,
): Promise<AuthorConfirm> {
  const res = await fetch(`${BASE}/stream/agents/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm_id: confirmId,
      answer,
      note: note || undefined,
      field_answers: fieldAnswers && Object.keys(fieldAnswers).length > 0 ? fieldAnswers : undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "提交作者确认失败");
  }
  return res.json() as Promise<AuthorConfirm>;
}

/** 作者主动跳过确认点（关闭弹窗）：后端 dismissed，生成任务按默认方向继续。 */
export async function dismissAuthorConfirm(confirmId: string): Promise<void> {
  const res = await fetch(`${BASE}/stream/agents/confirm/${confirmId}/dismiss`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "跳过作者确认失败");
  }
}

/** 调用角色 SSE 接口，逐事件回调（使用 fetch ReadableStream 手动解析 SSE）。 */
export async function runAgent(
  agent: string,
  novelId: string,
  params: Record<string, unknown>,
  onEvent: (ev: StreamEventData) => void,
  signal?: AbortSignal,
  dryRun = false,
  timeoutMs?: number,
): Promise<void> {
  // 超时兜底：代理/网络层偶发挂起时（曾见 SSE 长连接 500s+ 无响应），超过 timeoutMs 中断连接并抛错，
  // 避免 UI 永久"思考中"。注意：这里只断开前端读取，后端任务脱离请求生命周期会照常跑完并落库（刷新可见）。
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer =
    timeoutMs != null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  log.info(`runAgent start agent=${agent} novel=${novelId.slice(0, 8)} dryRun=${dryRun}`);
  try {
    const res = await fetch(`${BASE}/stream/agents/${agent}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ novel_id: novelId, params, dry_run: dryRun }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      log.error(`runAgent response !ok agent=${agent} status=${res.status}`);
      throw new Error("请求失败");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const dispatch = () => {
      // SSE 事件以空行分隔
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event: StreamEvent = "stream_delta";
        let data = "";
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim() as StreamEvent;
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        onEvent({ event, data: parsed });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      dispatch();
    }
    buffer += decoder.decode();
    dispatch();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

/** 把调试 dry_run 的产物显式加入正式库（不重新调用 AI）。 */
export async function commitAgent(
  agent: string,
  novelId: string,
  params: Record<string, unknown>,
  output: Record<string, unknown>,
  source?: string,
): Promise<{ action?: string; detail?: string }> {
  const res = await fetch(`${BASE}/stream/agents/${agent}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novel_id: novelId, params, output, source }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "提交失败");
  }
  return res.json();
}
