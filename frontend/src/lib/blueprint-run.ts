"use client";

/** 蓝图生成任务的模块级 store：与组件生命周期解耦。
 *
 * 为什么需要它：蓝图页是工作台的某个 tab，切到别的 tab 时组件会卸载，本地 state 随之丢失，
 * 但 SSE 请求仍在后端继续跑。把生成状态提升到模块级（useSyncExternalStore 订阅）后：
 * - 生成不因切换页面而中断；
 * - 回到蓝图页时流式输出、进度、结果自动恢复显示。
 */
import { friendlyRunError, getAgentRunningTask, getStreamStatus, runAgent, type AgentRunningTaskResult, type AuthorConfirm } from "./api";
import { pushAuthorConfirm } from "@/components/author-confirm";

export type BlueprintRunStatus = "idle" | "running" | "done" | "error";

export interface BlueprintRunState {
  /** 正在/最近一次生成所属的小说 id；null 表示当前没有任务 */
  novelId: string | null;
  status: BlueprintRunStatus;
  /** 蓝图师流式输出累积文本 */
  draftText: string;
  /** 模型推理过程文字（reasoning_content），用于"思考中"滚动提示 */
  thinkingText: string;
  /** 生成过程信息（如"蓝图已落库"） */
  msg: string | null;
  /** 生成失败信息 */
  errMsg: string | null;
  /** 开始时间戳（ms），用于展示用时 */
  startedAt: number | null;
}

const listeners = new Set<() => void>();

let state: BlueprintRunState = {
  novelId: null,
  status: "idle",
  draftText: "",
  thinkingText: "",
  msg: null,
  errMsg: null,
  startedAt: null,
};

function setState(patch: Partial<BlueprintRunState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribeBlueprintRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getBlueprintRun(): BlueprintRunState {
  return state;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 页面刷新后恢复：若后端有该小说的进行中蓝图任务，置 running 并轮询到结束。
 *
 * 刷新会重置模块级 state，但任务已在后端解耦为后台任务（agent_tasks）继续跑；
 * 这里只恢复"生成中"状态与最终结果（不重放流式文本），完成后由组件刷新版本列表。
 * 返回是否恢复到了进行中任务。
 */
export async function tryResumeBlueprintRun(novelId: string): Promise<boolean> {
  if (state.novelId === novelId && state.status === "running") return true; // 本页已有任务
  let running = false;
  try {
    const first = await getAgentRunningTask("blueprint_architect", novelId);
    if (!first.running || !first.task) return false;
    running = true;
    // 用后端已累积的流式文字恢复显示：刷新前已流出的思考/正文不会丢，随后轮询继续增量滚动
    const p = first.task.progress ?? { thinking: "", draft: "" };
    setState({
      novelId,
      status: "running",
      draftText: p.draft,
      thinkingText: p.thinking,
      msg: null,
      errMsg: null,
      // 用后端任务的真实开始时间恢复计时：刷新/切页后「已用时」从任务发起时刻算起，不再重新计
      startedAt: first.task.started_at ? new Date(first.task.started_at).getTime() : Date.now(),
    });
  } catch {
    return false;
  }

  void (async () => {
    const apply = (patch: Partial<BlueprintRunState>) => {
      if (state.novelId !== novelId) return;
      setState(patch);
    };
    try {
      while (true) {
        await sleep(1500);
        const r = await getAgentRunningTask("blueprint_architect", novelId);
        if (r.running) {
          // 任务仍在跑：增量刷新已流出的文字（后端累积值直接覆盖，幂等不重复追加）
          const p = r.task?.progress;
          if (p && (p.thinking !== state.thinkingText || p.draft !== state.draftText)) {
            apply({ thinkingText: p.thinking, draftText: p.draft });
          }
          continue;
        }
        if (r.task && r.task.status === "error") {
          apply({ status: "error", errMsg: r.task.error ?? "生成任务后台失败。" });
        } else {
          apply({ status: "done", msg: r.task?.msg ?? "生成完成。" });
        }
        break;
      }
    } catch (e) {
      apply({ status: "error", errMsg: friendlyRunError(e) });
    }
  })();
  return running;
}

/** 启动蓝图生成任务。同一部小说已有进行中的生成时不会重复启动（返回 false）。
 *  任务由模块级状态持有，即使切换页面导致组件卸载，生成仍会继续。
 *  importSource：导入模式，把用户上传的大纲文档文本交给蓝图师规范化（而非设定库）；
 *  docName：导入文件名（导入模式抽设定时用于标注来源）；
 *  useSettings：导入模式下是否继承设定库（true=设定库优先；false=全新开始，忽略旧设定，仅用本文档）。 */
export function startBlueprintRun(
  novelId: string,
  requirements: string,
  importSource?: string,
  docName?: string,
  useSettings = true,
): boolean {
  if (state.novelId === novelId && state.status === "running") return false;

  setState({
    novelId,
    status: "running",
    draftText: "",
    thinkingText: "",
    msg: null,
    errMsg: null,
    startedAt: Date.now(),
  });

  void (async () => {
    // 只允许写回当前任务的 patch；若期间用户发起了其他任务，过期回调一律丢弃
    const apply = (patch: Partial<BlueprintRunState>) => {
      if (state.novelId !== novelId) return;
      setState(patch);
    };
    let buf = "";
    let tbuf = "";
    let failed = false;
    let settled = false; // 收尾标记：SSE 正常结束或看门狗兜底结束，只允许一次

    // 兜底看门狗：SSE 的结束帧可能因代理/网络问题丢失，导致 runAgent 永不 resolve、
    // store 一直卡在 running（弹窗永远「生成中」、版本列表不自动刷新、弹窗不自动关闭）。
    // 这里轮询后端任务状态，任务一不在运行就把 store 收尾成 done/error，与 SSE 正常结束殊途同归。
    void (async () => {
      while (true) {
        await sleep(1500);
        if (settled) return;
        if (state.novelId !== novelId) return;
        let r: AgentRunningTaskResult;
        try {
          r = await getAgentRunningTask("blueprint_architect", novelId);
        } catch {
          continue; // 查询失败静默，下轮再试
        }
        if (r.running) continue; // 后端仍在跑，SSE 正常流式，继续等待
        settled = true;
        const s = getBlueprintRun();
        if (s.status !== "running") return; // SSE 已把结果置为 done/error（如 stream_error），不覆盖
        // 尽力识别后端失败：/status 的 recent 若是本角色的 error 任务，则报错而非误报完成
        try {
          const st = await getStreamStatus(novelId);
          if (st.recent && st.recent.agent === "blueprint_architect" && st.recent.status === "error") {
            apply({ status: "error", errMsg: st.recent.error ?? "生成失败，请重试。" });
            return;
          }
        } catch {
          /* 忽略，按完成处理 */
        }
        // 保留 SSE 已送达的版本文案（如「蓝图 v1 已生成完毕」）；没收到则用兜底文案
        apply({ status: "done", msg: s.msg ?? "生成完成。" });
        return;
      }
    })();

    try {
      await runAgent(
        "blueprint_architect",
        novelId,
        {
          requirements: requirements.trim() || undefined,
          ...(useSettings === false ? { use_settings: false } : {}),
          ...(importSource?.trim() ? { import_source: importSource.trim(), doc_name: docName || "导入的大纲文档" } : {}),
        },
        (ev) => {
          const d = ev.data as {
            delta?: string;
            status?: string;
            message?: string;
            action?: string;
            version?: number;
          };
          if (ev.event === "thinking_delta" && d.delta) {
            tbuf += d.delta;
            apply({ thinkingText: tbuf });
          } else if (ev.event === "stream_delta" && d.delta) {
            buf += d.delta;
            apply({ draftText: buf });
          } else if (ev.event === "notify" && d.message) {
            apply({ msg: d.message });
          } else if (ev.event === "stored" && d.action === "persisted" && d.version) {
            // 蓝图落库：把带版本号的完成文案写进状态，蓝图页完成提示（Message）据此显示"蓝图 vX 已生成完毕"
            apply({ msg: `蓝图 v${d.version} 已生成完毕` });
          } else if (ev.event === "schema_validate" && d.status !== "ok") {
            apply({ msg: "蓝图 schema 校验失败，可重试。" });
          } else if (ev.event === "stream_error") {
            failed = true;
            apply({ errMsg: d.message ?? "AI 生成蓝图出错，请稍后重试。", status: "error" });
          } else if (ev.event === "author_confirm") {
            // 生成流程确认点（如时代×行业研究结论）：全局弹窗交给作者定夺
            const c = (ev.data as { confirm?: AuthorConfirm }).confirm;
            if (c?.id && c.novel_id === novelId) pushAuthorConfirm(c);
          }
        },
      );
      settled = true;
      apply({ status: failed ? "error" : "done" });
    } catch (e) {
      settled = true;
      apply({ status: "error", errMsg: friendlyRunError(e) });
    }
  })();

  return true;
}
