"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import {
  activateBlueprint,
  checkOutlineSkeleton,
  deleteBlueprint,
  getBlueprintActivationStatus,
  importBlueprintFile,
  listBlueprints,
  type Blueprint,
  type BlueprintActivationStatusResult,
  type OutlineSkeletonModule,
} from "@/lib/api";
import {
  getBlueprintRun,
  startBlueprintRun,
  subscribeBlueprintRun,
  tryResumeBlueprintRun,
  type BlueprintRunStatus,
} from "@/lib/blueprint-run";
import { useElapsed } from "@/lib/use-elapsed";
import AgentStreamModal from "./agent-stream-modal";
import ConfirmDialog from "./confirm-dialog";
import InfoTip from "./info-tip";
import Modal from "./modal";
import { message } from "@/components/message";
import Loading from "@/components/loading";
import { CostHint, useAiStatus } from "@/lib/ai-status";

interface Props {
  novelId: string;
}

export default function BlueprintPanel({ novelId }: Props) {
  const [items, setItems] = useState<Blueprint[]>([]);
  // 数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(true);
  const [inputText, setInputText] = useState("");
  // 导入后骨架检测：关键词快速扫描立即提示，同时后台跑 LLM 语义校验覆盖结果（缺了提示，可跳过直接生成）
  const [outlineCheck, setOutlineCheck] = useState<OutlineCheckState | null>(null);
  // 复制大纲模板按钮的"已复制"反馈（短暂显示后恢复）
  const [copied, setCopied] = useState(false);
  // 新增蓝图弹窗（参考写作页「新增章节」：按钮 + Modal）
  const [showAddModal, setShowAddModal] = useState(false);
  // 导入后骨架 LLM 校验的取消控制器：清除导入/关闭弹窗/开始生成/刷新页面时 abort，避免请求继续跑完白耗资源
  const checkAbortRef = useRef<AbortController | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delTarget, setDelTarget] = useState<Blueprint | null>(null);
  // 激活确认：激活会把该蓝图内容注入写作/大纲/设定等页面，先弹风险确认框
  const [activateTarget, setActivateTarget] = useState<Blueprint | null>(null);
  // 正在后台激活的蓝图 id（按钮防抖 + 刷新/切页后从后端恢复「激活中…」；成功/失败才置空）
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 生成过程弹窗（DeepSeek 风格：思考过程折叠块 + 正文流式滚动），内容展示复用公共组件
  const [showStreamModal, setShowStreamModal] = useState(false);
  const { ensureReady } = useAiStatus();

  // 输入框内容：可手填作者要求，或「导入大纲」后填入文档全文（此时点「识别为蓝图」）
  // importName 非空 = 当前内容是导入的文档
  const [importName, setImportName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  // 生成任务状态来自模块级 store：切到其他 tab 再回来，流式输出/进度/结果依然在
  // 第三参 getServerSnapshot：SSR/预渲染时返回模块级初始态（React 19 要求），避免 500
  const run = useSyncExternalStore(subscribeBlueprintRun, getBlueprintRun, getBlueprintRun);
  const running = run.novelId === novelId && run.status === "running";
  const elapsed = useElapsed(running, running ? run.startedAt : null);

  // 输入框内容持久化：生成/导入时写入 localStorage，刷新或切换页面回来后自动反填，
  // 避免"生成中刷新 → 输入内容丢失"（用户明确要求反填回输入框）。
  const draftKey = `biling:blueprint-draft:${novelId}`;
  useEffect(() => {
    // 仅当存在进行中任务（生成中/刚恢复）时恢复草稿，避免污染正常新建
    if (run.novelId !== novelId || run.status !== "running") return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { text?: string; importName?: string | null } | null;
      if (saved?.text) {
        setInputText(saved.text);
        setImportName(saved.importName ?? null);
      }
    } catch {
      /* 忽略损坏数据 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, run.novelId, run.status]);

  const load = useCallback(async (): Promise<Blueprint[]> => {
    setLoading(true);
    try {
      const bps = await listBlueprints(novelId);
      setItems(bps);
      return bps;
    } catch (e) {
      message.error((e as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 激活轮询：后台激活期间每 1.5s 查询一次激活状态，「激活中…」保持到成功或失败才退出。
  // 刷新/切页后由 mount 恢复逻辑重新接管；组件卸载/切换小说时停止轮询（任务仍在后台跑）。
  const stopActivationPoll = useRef<() => void>(() => {});
  /** 当前面板所属小说：切换小说时用它让旧小说的轮询立即退场，不误弹提示 */
  const lastActivationNovelRef = useRef<string | null>(null);
  const pollActivation = useCallback(
    (novelId: string) => {
      stopActivationPoll.current(); // 停止上一轮（同一小说只保留一个轮询）
      let stopped = false;
      stopActivationPoll.current = () => {
        stopped = true;
      };
      void (async () => {
        while (!stopped) {
          await new Promise((r) => setTimeout(r, 1500));
          if (stopped) return;
          // 期间切换到其他小说：立即退场，不弹本小说的完成提示（状态由新小说自己的恢复逻辑接管）
          if (lastActivationNovelRef.current !== novelId) {
            stopActivationPoll.current = () => {};
            return;
          }
          let r: BlueprintActivationStatusResult;
          try {
            r = await getBlueprintActivationStatus(novelId);
          } catch {
            continue; // 查询失败静默，下轮再试
          }
          if (r.running) continue; // 仍在后台激活：按钮保持「激活中…」
          stopActivationPoll.current = () => {}; // 收尾后清掉停止句柄
          const t = r.task;
          if (t && t.status === "error") {
            setActivatingId(null);
            message.error(`蓝图激活失败：${t.error ?? "请稍后重试"}`);
          } else if (t && t.blueprint_id) {
            setActivatingId(null);
            message.success(t.msg ?? "已设为生效中，设定与文风已跟随切换。");
            if (t.warning) message.warning(t.warning);
          } else {
            // 无任务记录（异常情况）：直接退出激活中
            setActivatingId(null);
          }
          void load();
          return;
        }
      })();
    },
    [load],
  );

  // 切换小说：停止上一部小说的激活轮询、清空「激活中…」状态——各小说的激活状态互相隔离，
  // 上一部小说的激活任务完成/失败不会在当前小说工作台误弹提示。
  useEffect(() => {
    if (lastActivationNovelRef.current !== novelId) {
      lastActivationNovelRef.current = novelId;
      stopActivationPoll.current();
      stopActivationPoll.current = () => {};
      setActivatingId(null);
    }
  }, [novelId]);

  // 页面刷新 / 切页回来：若后端有该小说进行中的激活任务，恢复对应蓝图的「激活中…」并轮询到完成
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let r: BlueprintActivationStatusResult;
      try {
        r = await getBlueprintActivationStatus(novelId);
      } catch {
        return;
      }
      if (stopped) return;
      if (!r.running || !r.task?.blueprint_id) return;
      setActivatingId(r.task.blueprint_id);
      setSelectedId(r.task.blueprint_id);
      pollActivation(novelId);
    })();
    return () => {
      stopped = true;
    };
  }, [novelId, pollActivation]);

  // 组件卸载时停止激活轮询（任务在后台继续，回来后由上方 mount 效果重新接管）
  useEffect(() => {
    return () => {
      stopActivationPoll.current();
      stopActivationPoll.current = () => {};
    };
  }, []);

  // 页面刷新 / 组件卸载时：取消进行中的骨架 LLM 校验请求（浏览器断开前主动 abort，避免残留请求继续跑）
  useEffect(() => {
    const cancelCheck = () => {
      checkAbortRef.current?.abort();
      checkAbortRef.current = null;
    };
    window.addEventListener("beforeunload", cancelCheck);
    return () => {
      window.removeEventListener("beforeunload", cancelCheck);
      cancelCheck();
    };
  }, []);

  // 页面刷新后：若后端有该小说的进行中蓝图任务（agent_tasks），恢复"生成中"状态并轮询到完成。
  // 完成后 justFinished effect 会触发 load()，刷新版本列表。
  useEffect(() => {
    void tryResumeBlueprintRun(novelId);
  }, [novelId]);

  // 生成结束（在本页完成，或切走后期间完成）→ 刷新版本列表，新版蓝图自动出现
  const prevStatus = useRef<BlueprintRunStatus | null>(null);
  useEffect(() => {
    const justFinished = run.novelId === novelId && prevStatus.current === "running" && run.status !== "running";
    if (justFinished) {
      void load();
    }
    prevStatus.current = run.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.novelId, novelId, load]);

  // 生成结束（本页或后台完成）：刷新版本列表 + 关闭弹窗清空草稿 + 弹 Message 消息提示（居中靠上）。
  // Message 仅蓝图页可见；跨页完成时用户不在本页，由全局 Notification（右上角）提示，两者不重复。
  const prevRunStatus = useRef<BlueprintRunStatus | null>(null);
  useEffect(() => {
    const own = run.novelId === novelId;
    const prev = prevRunStatus.current;
    if (own && prev === "running" && run.status === "done") {
      // Message 消息提示（居中靠上）：完成反馈，含版本号（如"蓝图 v1 已生成完毕"）
      message.success(run.msg ?? "蓝图已生成完毕");
      // 生成完成：自动关闭「生成过程」与「新增蓝图」弹窗，并清空输入草稿（含 localStorage）
      setShowStreamModal(false);
      setShowAddModal(false);
      setInputText("");
      setImportName(null);
      setOutlineCheck(null);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* 忽略存储异常 */
      }
    } else if (own && prev === "running" && run.status === "error") {
      message.error(`蓝图生成失败：${run.errMsg ?? "请稍后重试"}`);
    }
    prevRunStatus.current = run.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.novelId, novelId, run.errMsg, run.msg]);

  // 生成过程弹窗：流式滚动与思考折叠在公共组件 AgentStreamModal 内处理

  // 默认选中当前生效中的蓝图（无则回退第一条）；用户手动点选后以点选为准
  const selected = items.find((b) => b.id === selectedId) ?? items.find((b) => b.status === "active") ?? items[0] ?? null;
  const c = selected?.content;

  function handleGenerate() {
    if (!inputText.trim()) {
      message.error("请输入作者要求，或先点「导入大纲」填入文档内容。");
      return;
    }
    try {
      ensureReady();
    } catch (e) {
      message.error((e as Error).message);
      return;
    }
    // 生成前把输入内容持久化：刷新/切页后任务在后台继续，回来时反填输入框
    try {
      localStorage.setItem(draftKey, JSON.stringify({ text: inputText, importName }));
    } catch {
      /* 忽略存储失败 */
    }
    if (importName) {
      // 导入模式：以文档全文为素材生成蓝图；use_settings=false 意味着本次完全独立，
      // 不读取/核对之前任何蓝图激活注入的设定（每个版本独立启用，不与旧版本混合）；
      // 设定/文风不会在生成时自动注入，需把该版本「设为生效中」（确认后）才触发后端抽取并注入设定库 + 全局文风
      startBlueprintRun(novelId, inputText, inputText, importName, false);
    } else {
      startBlueprintRun(novelId, inputText);
    }
    // 顶部悬浮提示：蓝图开始生成（完成/失败由下方 status 监听 effect 提示）
    message.success("蓝图正在生成中…生成期间可点「查看生成过程」查看进度");
    // 弹窗保持打开，生成期间输入锁定、导入/清除隐藏；右侧出现「查看生成过程」入口
    // 取消尚未完成的骨架校验（结果不再需要）
    checkAbortRef.current?.abort();
    checkAbortRef.current = null;
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许再次选择同一文件
    if (!file) return;
    setImporting(true);
    try {
      const res = await importBlueprintFile(novelId, file);
      // 导入成功不提示，直接填入文本框，可在下方编辑后生成蓝图
      setImportName(res.filename);
      setInputText(res.text);
      // 骨架检测：先用关键词快速扫描立即给出初筛提示，同时后台跑 LLM 语义校验，结果回来覆盖
      setOutlineCheck({ status: "pending", source: "keyword", modules: keywordOutlineCheck(res.text) });
      // 取消上一次未完成的校验（比如之前导入后又清空/换文件），再发起新请求，供清空内容时 abort
      checkAbortRef.current?.abort();
      const ctrl = new AbortController();
      checkAbortRef.current = ctrl;
      void checkOutlineSkeleton(novelId, res.text, ctrl.signal)
        .then((r) => {
          // 仅当本次请求仍是最新的才覆盖结果（防止清空/换文件后被旧结果污染）
          if (checkAbortRef.current === ctrl) {
            setOutlineCheck({ status: "done", source: "llm", modules: r.modules });
            // AI 校验通过（骨架完整无缺失）：无提示块可看，弹顶部悬浮提示让用户明确知道结果
            if (r.modules.length > 0 && r.modules.every((m) => m.ok)) {
              message.success("AI 校验通过：大纲骨架完整，可直接生成蓝图");
            }
          }
        })
        .catch(() => {
          // 用户主动取消（清空/关闭弹窗）时 prev 已被置空，保持空；仅当仍是最新请求才标 done
          if (checkAbortRef.current === ctrl) setOutlineCheck((prev) => (prev ? { ...prev, status: "done" } : prev));
        });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  /** 一键复制大纲模板文本（供粘贴进文本框或发给 AI 按模板整理大纲）。 */
  async function handleCopyOutlineTemplate() {
    try {
      await copyText(OUTLINE_TEMPLATE_TEXT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error("复制失败，请手动复制模板。");
    }
  }

  /** 设为生效中：激活即把该蓝图内容注入写作/大纲/设定等页面，先弹风险确认框（新增蓝图一律手动激活）。 */
  function handleActivateClick(b: Blueprint) {
    setActivateTarget(b);
  }

  async function doActivate(b: Blueprint) {
    if (activatingId) return;
    // 先置「激活中…」：按钮立即反馈，且防止重复点击（后端同样有并发兜底 409）
    setActivatingId(b.id);
    setSelectedId(b.id);
    let res;
    try {
      res = await activateBlueprint(novelId, b.id);
    } catch (e) {
      // 请求失败（如已有任务在激活 409 / 网络错误）：立即退出激活中
      setActivatingId(null);
      message.error((e as Error).message);
      return;
    }
    if (!res.running) {
      // 已生效（并发下其他请求已完成）：无需轮询，直接刷新展示
      setActivatingId(null);
      message.success(`v${b.version} 已设为生效中，设定与文风已跟随切换。`);
      void load();
      return;
    }
    // 后台激活进行中：轮询到成功/失败才退出「激活中…」（刷新/切页不中断）
    pollActivation(novelId);
  }

  async function confirmActivate() {
    if (!activateTarget || activatingId) return;
    const b = activateTarget;
    setActivateTarget(null);
    await doActivate(b);
  }

  async function handleDelete(b: Blueprint) {
    setDelTarget(b);
  }

  async function confirmDelete() {
    if (!delTarget || deleting) return;
    setDeleting(true);
    const b = delTarget;
    setDelTarget(null);
    try {
      await deleteBlueprint(novelId, b.id);
      message.success(`v${b.version} 已删除。`);
      if (selectedId === b.id) setSelectedId(null);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  /** 关闭新增蓝图弹窗：取消未完成的 AI 校验；输入框内容与导入状态保留，重新进入时内容仍在（生成完成时才清空）。 */
  function closeAddModal() {
    checkAbortRef.current?.abort();
    checkAbortRef.current = null;
    setShowAddModal(false);
    // 骨架校验若因 abort 停在 pending，降级为 done，避免再次进入时输入框被锁定
    setOutlineCheck((prev) => (prev && prev.status === "pending" ? { ...prev, status: "done" } : prev));
  }

  const statusBadge = (s: Blueprint["status"]) =>
    s === "active" ? (
      <span className="shrink-0 whitespace-nowrap rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">生效中</span>
    ) : (
      <span className="shrink-0 whitespace-nowrap rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">未生效</span>
    );

  return (
    <Loading loading={loading}>
      <div className="grid items-start gap-6 lg:grid-cols-[300px_1fr]">
      <aside className="panel flex min-w-0 max-h-[calc(100dvh-6rem)] flex-col gap-3">
        <div className="panel-head mb-0">
          <h3 className="panel-title">蓝图版本</h3>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="btn btn-primary px-2.5 py-1 text-xs font-medium"
          >
            新增蓝图
          </button>
        </div>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
            还没有蓝图。点右上角「新增蓝图」，让蓝图师整理世界蓝图（规则/人物弧/分卷/伏笔计划）。
          </p>
        ) : (
          <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
            {items.map((b) => (
              <li key={b.id}>
                <button
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected?.id === b.id
                      ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
                      : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                  }`}
                  onClick={() => setSelectedId(b.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">v{b.version} {b.content?.title ?? ""}</span>
                    {statusBadge(b.status)}
                  </div>
                  <div className="mt-0.5 line-clamp-1 text-[11px] text-zinc-500">{b.content?.logline ?? ""}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="flex min-w-0 flex-col gap-5 sm:gap-7">
        {!selected && (
          <div className="panel flex min-h-0 flex-col gap-3">
            <div className="panel-head mb-0">
              <h3 className="panel-title">蓝图详情</h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              还没有蓝图。点左侧「新增蓝图」，让蓝图师整理世界蓝图（规则/人物弧/分卷/伏笔计划）。
            </p>
          </div>
        )}

        {/* ② 蓝图详情 */}
        {selected && (
          <div className="panel flex min-h-0 h-[calc(100dvh-6rem)] flex-col">
            <div className="panel-head">
              <h3 className="panel-title">
                蓝图 v{selected.version} {c?.title ?? ""}
                {statusBadge(selected.status)}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {selected.status !== "active" && (
                  <button
                    className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => handleActivateClick(selected)}
                    disabled={activatingId !== null}
                  >
                    {activatingId !== null ? "激活中…" : "设为生效中"}
                  </button>
                )}
                {selected.status !== "active" && (
                  <button
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                    onClick={() => handleDelete(selected)}
                    disabled={activatingId !== null}
                  >
                    删除
                  </button>
                )}
                {selected.status === "active" && (
                  <span className="rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 text-xs text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                    当前生效中 · 不可删除，切换前请先激活其他蓝图
                  </span>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
            {c?.logline && (
              <p className="mb-2 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
                <span className="font-semibold">一句话：</span>
                {c.logline}
              </p>
            )}
            {c?.theme && (
              <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-semibold">主题：</span>
                {c.theme}
              </p>
            )}
            {c?.core_conflict && (
              <p className="mb-3 text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-semibold">核心冲突：</span>
                {c.core_conflict}
              </p>
            )}

            {(c?.total_word_count || c?.total_chapters || c?.chapter_word_count) && (
              <p className="mb-3 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-900">
                <span className="font-semibold">全书体量规划：</span>
                {c.total_word_count ? `总字数 ${c.total_word_count}` : ""}
                {c.total_word_count && c.total_chapters ? " · " : ""}
                {c.total_chapters ? `总章数 ${c.total_chapters}` : ""}
                {(c.total_word_count || c.total_chapters) && c.chapter_word_count ? " · " : ""}
                {c.chapter_word_count ? `单章 ${c.chapter_word_count}` : ""}
              </p>
            )}

            {c?.world_rules && c.world_rules.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">世界规则</h4>
                <ul className="flex flex-col gap-1">
                  {c.world_rules.map((r, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      <span className="font-medium">{r.name}</span>：{r.detail}
                      {r.constraints?.length ? (
                        <span className="ml-2 text-[11px] text-red-500 dark:text-red-400">约束：{r.constraints.join("；")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {c?.character_arcs && c.character_arcs.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">人物弧光</h4>
                <ul className="flex flex-col gap-1">
                  {c.character_arcs.map((a, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      <span className="font-medium">{a.character}</span>
                      {a.personality ? <span className="ml-1.5 text-[11px] text-zinc-500">性格：{a.personality}</span> : null}
                      ：{a.start} → {a.end}
                      {a.turning_points?.length ? (
                        <span className="ml-2 text-[11px] text-zinc-500">转折：{a.turning_points.join("；")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {c?.volumes && c.volumes.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">分卷</h4>
                <div className="flex flex-wrap gap-1.5">
                  {c.volumes.map((v, i) => (
                    <span key={i} className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs dark:border-zinc-800">
                      第{v.no}卷《{v.name}》{v.focus}
                      {v.word_count ? <span className="ml-1 text-[11px] text-zinc-400">（{v.word_count}）</span> : null}
                      （{v.chapters_range}）
                    </span>
                  ))}
                </div>
              </div>
            )}

            {c?.foreshadowing_plan && c.foreshadowing_plan.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">伏笔计划</h4>
                <ul className="flex flex-col gap-1">
                  {c.foreshadowing_plan.map((f, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      第{f.plant_chapter}章埋 → 第{f.payoff_chapter}章揭：{f.desc}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {c?.subplots && c.subplots.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">长线支线</h4>
                <ul className="flex flex-col gap-1">
                  {c.subplots.map((s, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {c?.notes && c.notes.length > 0 && (
              <div className="mb-3">
                <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">保留要点（原文）</h4>
                <ul className="flex flex-col gap-1">
                  {c.notes.map((n, i) => (
                    <li key={i} className="text-sm text-zinc-700 dark:text-zinc-300">
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            </div>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={delTarget !== null}
        title={delTarget ? `删除蓝图 v${delTarget.version}？` : "删除蓝图？"}
        message="删除后，该蓝图及其导入的设定、文风将一并清除，且不可恢复。"
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setDelTarget(null)}
      />

      {/* 切换生效中风险确认：所有未生效蓝图激活前一律弹风险确认框（新增蓝图不自动生效） */}
      <ConfirmDialog
        open={activateTarget !== null}
        title={activateTarget ? `将 v${activateTarget.version} 设为生效中？` : "设为生效中？"}
        message={`确认后将把 v${activateTarget ? activateTarget.version : ""} 设为生效中：该版本（若为导入生成）会同步抽取设定与文风并注入设定库、全局文风，注入完成按钮的「激活中」才会结束（期间刷新页面或切换页面不会中断，按钮会保持「激活中…」直到成功或失败）；当前生效蓝图导入的内容将被隐藏（不会删除，可随时切回）、改用新蓝图导入的内容。\n\n若后续的正文、大纲已基于旧蓝图生成，切换后可能导致设定不一致、影响写作连贯性。已生成的大纲和文章不会被修改。\n\n确定切换吗？`}
        confirmText="确定切换"
        tone="primary"
        onConfirm={confirmActivate}
        onCancel={() => setActivateTarget(null)}
      />

      {/* ── 新增蓝图弹窗 ── */}
      <Modal
        open={showAddModal}
        title="新增蓝图"
        subtitle="蓝图 = 整本书的底稿：主题、核心冲突、人物弧光、分卷和伏笔计划。每一版都会保留，激活生效的那版才是大纲师/小说家遵循的。"
        onClose={closeAddModal}
        maxWidth="max-w-xl"
        fill
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={closeAddModal}
              className="btn btn-ghost px-4 py-1.5"
            >
              取消
            </button>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline">
                <CostHint />
              </span>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={running || importing || outlineCheck?.status === "pending" || !inputText.trim()}
                className="btn btn-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? "生成中…" : importName ? "识别为蓝图" : "生成蓝图"}
              </button>
              {/* 点击生成后出现：打开生成过程弹窗（DeepSeek 风格，思考+正文流式滚动）；生成完毕即隐藏 */}
              {run.novelId === novelId && running && (
                <button
                  type="button"
                  onClick={() => setShowStreamModal(true)}
                  className="btn btn-ghost px-3 py-1.5"
                >
                  查看生成过程
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* 生成期间按钮不隐藏、仅禁止点击（等蓝图生成完毕解除） */}
            <button
              type="button"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              onClick={() => fileRef.current?.click()}
              disabled={importing || running || outlineCheck?.status === "pending"}
            >
              {importing ? "导入中…" : "导入大纲"}
            </button>
            {importName && (
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={() => {
                  checkAbortRef.current?.abort();
                  checkAbortRef.current = null;
                  setInputText("");
                  setImportName(null);
                  setOutlineCheck(null);
                }}
                disabled={running || outlineCheck?.status === "pending"}
              >
                清除导入
              </button>
            )}
            {/* 大纲模板参考：一键复制给 AI 识别的模板文本，? 悬浮说明在按钮内部、仅图标触发（InfoTip 渲染到 body，不被弹窗遮挡） */}
            <div className="ml-auto">
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                onClick={handleCopyOutlineTemplate}
              >
                {copied ? "已复制" : "复制大纲模板"}
                <InfoTip side="bottom" align="right" width="w-80">
                  <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">
                    推荐结构（顺序可调整、模块可增删）
                  </p>
                  <ol className="list-decimal pl-4">
                    <li><b>全书总纲</b>：一句话故事 · 核心主题 · 全书体量（总字数/总章数/单章字数）· 核心冲突或叙事逻辑</li>
                    <li><b>分卷结构</b>：每卷 = 卷名 + 章节范围 + 本卷重点 + 核心剧情</li>
                    <li><b>人物设定</b>：主角 = 姓名/性格/起点→终点/成长转折；重要配角有则必写</li>
                    <li><b>主线与支线</b>：主线剧情走向 + 长效支线</li>
                    <li><b>世界观/规则</b>：题材相关才写（系统/力量体系/世界规则）</li>
                    <li><b>伏笔计划</b>：选填，有具体埋/揭安排才写（无则留空，由大纲师规划）</li>
                    <li><b>爽点/节奏规划</b>：通用模块，按前期/中期/后期排爽点·钩子·糖点，防节奏枯竭</li>
                    <li><b>差异化/卖点定位</b>：通用模块，对标作品 · 独特设定 · 立意/平台卖点，回答"凭什么被记住"</li>
                  </ol>
                  <p className="mt-1.5 text-[11px] text-zinc-400">
                    点击按钮复制模板文本：可粘贴进文本框作为底稿，或发给 AI 按模板整理你的大纲。
                  </p>
                </InfoTip>
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".docx,.pdf,.md,.markdown,.txt"
              className="hidden"
              onChange={handleImportFile}
            />
          </div>

          <textarea
            ref={boxRef}
            className="min-h-0 w-full flex-1 resize-none overflow-y-auto rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder={
              running
                ? "蓝图正在生成中，输入框暂时锁定；生成完成后即可继续编辑或重新导入。"
                : importName
                  ? `已导入「${importName}」：下面是文档全文，可直接修改，完成后点「识别为蓝图」。`
                  : "作者补充要求（可选：类型/主题/风格取向…），也可以先点「导入大纲」把文档填进来。"
            }
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            // 生成中 / AI 骨架校验中禁止编辑：用 readOnly 而非 disabled，保证已有内容正常显示不被淡化
            readOnly={running || outlineCheck?.status === "pending"}
          />

          {/* 导入后骨架检测：先关键词初筛立即提示，AI 语义校验结果回来覆盖；只列缺失模块，可跳过直接生成。高度随内容自适应，最多占弹窗一半，超出自身滚动 */}
          {importName &&
            !running &&
            outlineCheck &&
            (outlineCheck.status === "pending" || outlineCheck.modules.some((m) => !m.ok)) && (
              <div className="shrink-0 max-h-[50%] overflow-y-auto rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-800 dark:bg-amber-950/60">
                {outlineCheck.status === "pending" && !outlineCheck.modules.some((m) => !m.ok) ? (
                  /* AI 语义校验进行中且关键词初筛无缺失：给用户加载反馈（说明输入框为何暂时锁定） */
                  <div className="flex items-center gap-2">
                    <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                    <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
                      正在用 AI 校验大纲骨架…（校验期间输入框暂时锁定，完成后即可编辑）
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
                      {outlineCheck.status === "pending"
                        ? "大纲骨架快速扫描：以下模块建议补充（AI 语义校验中…）"
                        : outlineCheck.source === "llm"
                          ? "大纲骨架 AI 语义校验：以下模块建议补充（可跳过直接生成）"
                          : "大纲骨架快速扫描：以下模块建议补充（AI 校验暂不可用，可跳过直接生成）"}
                    </p>
                    <ul className="mt-1.5 flex flex-col gap-1.5">
                      {outlineCheck.modules
                        .filter((m) => !m.ok)
                        .map((m) => (
                          <li key={m.id} className="text-xs leading-5 text-amber-700 dark:text-amber-300">
                            {m.optional ? (
                              <span className="text-amber-500/90 dark:text-amber-400/90">（选填建议）{m.reason}</span>
                            ) : (
                              m.reason
                            )}
                          </li>
                        ))}
                    </ul>
                  </>
                )}
              </div>
            )}
        </div>
      </Modal>

      {/* ── 生成过程弹窗：DeepSeek 网页版同款交互（复用公共组件） ── */}
      <AgentStreamModal
        open={showStreamModal}
        onClose={() => setShowStreamModal(false)}
        title="蓝图师生成过程"
        running={running}
        draftText={run.draftText}
        thinkingText={run.thinkingText}
        error={run.status === "error"}
        elapsed={elapsed}
        emptyRunningText={
          "模型正在深度思考与整理蓝图（推理模型思考期约 1-3 分钟，此阶段通常没有正文输出），\n正文开始生成后会在这里实时滚动显示…"
        }
        emptyDoneText="生成完成，新蓝图已出现在版本列表，可关闭此弹窗查看。"
      />
      </div>
    </Loading>
  );
}

/** 导入后骨架检测状态：
 *  - pending：关键词快速扫描已出初筛结果，AI 语义校验进行中；
 *  - done：终态（source=llm 为 AI 语义校验结果；source=keyword 为 AI 不可用时的关键词扫描回退）。
 *  六个通用大纲模块：必填骨架四件套（全书体量、分卷/章节结构、核心人物、主线/支线）
 *  + 选填建议两项（爽点节奏 pacing、差异化卖点 differentiators，模块通用、内容因书而异）。
 *  世界规则/伏笔等题材相关模块不在此列——由蓝图师按材料实际情况取舍，避免误拦现实题材。 */
interface OutlineCheckState {
  status: "pending" | "done";
  source: "keyword" | "llm";
  modules: OutlineSkeletonModule[];
}

const OUTLINE_CHECKS: {
  id: OutlineSkeletonModule["id"];
  hint: string;
  patterns: RegExp[];
  optional?: boolean;
}[] = [
  {
    id: "scale",
    hint: "未检测到全书体量规划，补充总字数/总章数/单章字数，如「240万字 · 800章 · 3000字/章」",
    patterns: [
      /\d[\d.,]*\s*万\s*字/, // 240万字 / 240万 字
      /[一二三四五六七八九十百千零]+\s*万\s*字/, // 二百四十万字
      /总字数|总体量|总章数|章节数|单章字数|单章标准|字\/章|字每章/,
      /\d+\s*章/, // 800章 / 120章
    ],
  },
  {
    id: "volumes",
    hint: "未检测到分卷/章节结构，补充卷名 + 章节范围（如【第1-85章】）+ 本卷重点/剧情；仅有「第X卷：字数｜章数」的数据表不算分卷结构",
    patterns: [
      /【\s*第?\s*\d+\s*[-–—\u2011~～至]\s*\d+\s*章?/, // 章节范围【第1-85章】/【1-85章】
      /第[一二三四五六七八九十百千零\d]+[卷部][:：]?\s*【/, // 第X卷【章节范围】
      /卷名\s*[:：]/, // 卷名：
      /本卷重点|本卷剧情|本卷核心|本卷概要|本卷目标/, // 卷级重点/剧情标注
      /第[一二三四五六七八九十百千零\d]+章\s*[:：]/, // 第一章：标题（章节列表）
    ],
  },
  {
    id: "characters",
    hint: "未检测到核心人物设定，补充主角（至少）的姓名/性格/起点→终点/成长转折，配角有则一并列出",
    patterns: [
      /主角|配角|人物|角色|人设|人物弧|弧光|姓名|性格|成长线|成长弧线|心性/,
    ],
  },
  {
    id: "plot",
    hint: "未检测到主线/支线，补充主线剧情走向或长效支线，如「核心剧情走向：…」",
    patterns: [
      /剧情|故事|主线|支线|剧情线|故事线|走向|梗概|核心逻辑|滚雪球/,
    ],
  },
  {
    id: "pacing",
    optional: true,
    hint: "未检测到爽点/节奏规划（选填建议），可按前期/中期/后期补充，如「前期：新手成长、吊打行业乱象」",
    patterns: [
      /爽点|爽感|钩子|糖点|期待感|节奏|高潮|情绪点|爆点/,
    ],
  },
  {
    id: "differentiators",
    optional: true,
    hint: "未检测到差异化/卖点定位（选填建议），可补充对标作品、独特设定、立意卖点，如「对标《工业之心》；系统认知绑定、办学创新」",
    patterns: [
      /差异化|卖点|对标|参考作品|独特设定|不撞|创新点|立意|平台流量/,
    ],
  },
];

/** 关键词快速扫描（AI 语义校验结果回来前的即时初筛；后端 LLM 失败时也用它兜底）。 */
function keywordOutlineCheck(text: string): OutlineSkeletonModule[] {
  return OUTLINE_CHECKS.map((c) => {
    const hit = c.patterns.some((re) => re.test(text));
    return {
      id: c.id,
      ok: hit,
      reason: hit ? "已检测到相关内容" : c.hint,
      optional: c.optional,
    };
  });
}

/** 一键复制的大纲模板文本：给 AI 识别的模板，AI 按此结构把作者信息整理成规范大纲。 */
const OUTLINE_TEMPLATE_TEXT = `请把我的大纲信息，按下面模板整理成规范的全书大纲（保留所有信息、结构化输出）：

一、全书总纲
- 一句话故事：
- 核心主题：
- 全书体量（总字数/总章数/单章字数）：
- 核心冲突或叙事逻辑：

二、分卷结构（每卷）
- 卷名【章节范围】
- 本卷重点：
- 核心剧情：

三、人物设定
- 主角：姓名 / 性格特质 / 起点 → 终点 / 成长转折
- 重要配角：姓名 / 定位 / 弧线

四、主线与支线
- 主线剧情走向：
- 长效支线：

五、世界观/规则（题材相关才写）
- 世界规则 / 力量体系 / 系统设定：

六、伏笔计划（选填，有具体埋设/回收安排才写）
- 伏笔描述：埋设章节 → 回收章节

七、爽点/节奏规划（通用模块：按阶段规划阅读爽点/钩子，防节奏枯竭；悬疑称钩子、恋爱称糖点、爽文称爽点）
- 前期爽点：
- 中期爽点：
- 后期爽点：

八、差异化/卖点定位（通用模块：回答"凭什么不撞文、凭什么被记住"）
- 对标作品 / 独特设定：
- 立意 / 平台卖点：`;

/** 复制文本到剪贴板：优先异步 Clipboard API；权限被拒/不可用时回退 execCommand。 */
function copyText(text: string): Promise<void> {
  const fallback = () =>
    new Promise<void>((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) resolve();
        else reject(new Error("execCommand copy 失败"));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallback());
  }
  return fallback();
}

