/**
 * @file blueprint-panel.tsx
 * 蓝图页面板：管理整本书的世界蓝图——版本列表、详情展示、新增生成、大纲文档导入与激活切换。
 * 核心机制：生成任务走模块级 store + SSE（useSyncExternalStore，切页/刷新后仍可恢复）；
 * 激活状态 1.5s 轮询（跨小说用 ref 隔离，避免误弹提示）；输入草稿与导入会话分别持久化
 * 到 localStorage 断点续作；导入后骨架检测采用「关键词初筛 + LLM 语义校验覆盖」两段式。
 * 结构：本文件只做状态编排与组合子组件；子模块按逻辑边界拆到 components/blueprint/ 下——
 * blueprint-utils.ts（骨架检测纯函数/类型、大纲模板本地缓存）、status-badge.tsx（生效徽章）、
 * version-list.tsx（版本列表）、detail.tsx（详情区）、add-modal.tsx（新增蓝图弹窗）。
 */
"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import {
  activateBlueprint,
  checkOutlineSkeleton,
  deleteBlueprint,
  friendlyTaskError,
  getBlueprintActivationStatus,
  getOutlineTemplate,
  importBlueprintFile,
  listBlueprints,
  type Blueprint,
  type BlueprintActivationStatusResult,
} from "@/lib/api";
import {
  getBlueprintRun,
  startBlueprintRun,
  subscribeBlueprintRun,
  restoreBlueprintRun,
  finishRestoredBlueprintRun,
  type BlueprintRunStatus,
} from "@/lib/blueprint-run";
import { getAgentTaskRecoverySnapshot, getRecoveryTask, subscribeAgentTaskRecovery } from "../components/agent-task-recovery";
import { useElapsed } from "@/lib/use-elapsed";
import { copyText } from "@/utils/clipboard";
import AgentStreamModal from "../components/agent-stream-modal";
import ConfirmDialog from "@/components/confirm-dialog";
import { message } from "@/components/message";
import Loading from "@/components/loading";
import { useAiStatus } from "@/lib/ai-status";
import {
  keywordOutlineCheck,
  OUTLINE_TEMPLATE_TEXT,
  type OutlineCheckState,
} from "./components/blueprint-utils";
import { BlueprintVersionList } from "./components/version-list";
import { BlueprintDetail } from "./components/detail";
import { BlueprintAddModal } from "./components/add-modal";

interface Props {
  novelId: string;
}

export default function BlueprintPanel({ novelId }: Props) {
  // 蓝图版本列表（后端为单一事实来源：生成/删除/激活完成后重新拉取）
  const [items, setItems] = useState<Blueprint[]>([]);
  // 数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(true);
  // 输入框内容：作者手填的要求，或「导入大纲」后的文档全文（生成前持久化，刷新后可反填）
  const [inputText, setInputText] = useState("");
  // 导入后骨架检测：关键词快速扫描立即提示，同时后台跑 LLM 语义校验覆盖结果（缺了提示，可跳过直接生成）
  const [outlineCheck, setOutlineCheck] = useState<OutlineCheckState | null>(null);
  // 复制大纲模板按钮的"已复制"反馈（短暂显示后恢复）
  const [copied, setCopied] = useState(false);
  // 新增蓝图弹窗（参考写作页「新增章节」：按钮 + Modal）
  const [showAddModal, setShowAddModal] = useState(false);
  // 导入后骨架 LLM 校验的取消控制器：清除导入/关闭弹窗/开始生成/刷新页面时 abort，避免请求继续跑完白耗资源
  const checkAbortRef = useRef<AbortController | null>(null);
  // 当前选中的蓝图 id：默认跟随「生效中」版本，用户手动点选后以点选为准
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 待删除的蓝图：非空即弹出删除确认框，确认后才真正执行删除
  const [delTarget, setDelTarget] = useState<Blueprint | null>(null);
  // 激活确认：激活会把该蓝图内容注入写作/大纲/设定等页面，先弹风险确认框
  const [activateTarget, setActivateTarget] = useState<Blueprint | null>(null);
  // 正在后台激活的蓝图 id（按钮防抖 + 刷新/切页后从后端恢复「激活中…」；成功/失败才置空）
  const [activatingId, setActivatingId] = useState<string | null>(null);
  // 删除请求进行中：防止删除确认框被重复提交
  const [deleting, setDeleting] = useState(false);
  // 生成过程弹窗（DeepSeek 风格：思考过程折叠块 + 正文流式滚动），内容展示复用公共组件
  const [showStreamModal, setShowStreamModal] = useState(false);
  // AI 服务状态检查：生成前确认模型已配置可用，未配置则抛错拦截（避免发起注定失败的空请求）
  const { ensureReady } = useAiStatus();

  // 输入框内容：可手填作者要求，或「导入大纲」后填入文档全文（此时点「识别为蓝图」）
  // importName 非空 = 当前内容是导入的文档
  const [importName, setImportName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // 生成任务状态来自模块级 store：切到其他 tab 再回来，流式输出/进度/结果依然在
  // 第三参 getServerSnapshot：SSR/预渲染时返回模块级初始态（React 19 要求），避免 500
  const run = useSyncExternalStore(subscribeBlueprintRun, getBlueprintRun, getBlueprintRun);
  // 是否为「本小说」正在生成：run 是模块级 store，可能是其他小说的任务，必须按 novelId 过滤
  const running = run.novelId === novelId && run.status === "running";
  // 生成已耗时（仅 running 期间走表，任务停止/切走后归零）
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

  // 导入会话自动持久化：importName 非空时把「文档全文 + 文件名 + AI 校验状态」写入 localStorage，
  // 供关闭弹窗/切换页面/刷新后重开「新增蓝图」时恢复（含进行中校验的自动续跑）。
  // 清空导入或生成完成后 importName 置空，自动清除该会话；生成进行中不写入（该场景由 draftKey 恢复草稿）。
  const importKey = `biling:blueprint-import:${novelId}`;
  useEffect(() => {
    if (!importName) {
      try {
        localStorage.removeItem(importKey);
      } catch {
        /* 忽略存储异常 */
      }
      return;
    }
    if (run.novelId === novelId && run.status === "running") return;
    try {
      localStorage.setItem(importKey, JSON.stringify({ text: inputText, importName, outlineCheck }));
    } catch {
      /* 忽略存储失败 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importName, inputText, outlineCheck, run.novelId, run.status, novelId]);

  /** 拉取该小说的蓝图版本列表：成功写入 items 并返回列表；失败弹错误提示并返回 []（调用方据返回值判断）。 */
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
            message.error(`切换失败：${friendlyTaskError(t.error, "请稍后重试")}`);
          } else if (t && t.blueprint_id) {
            setActivatingId(null);
            message.success(t.msg ?? "已设为当前使用，设定和文风已跟随切换。");
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

  // 工作台级任务恢复协调器的蓝图订阅：不在蓝图页重复查询 running 状态。
  useEffect(() => {
    let hadTask = false;
    const sync = () => {
      const snapshot = getAgentTaskRecoverySnapshot();
      const task = getRecoveryTask("blueprint_architect", novelId);
      if (!snapshot.initialized) return;
      if (task) {
        hadTask = true;
        restoreBlueprintRun(task, novelId);
      } else if (hadTask) {
        finishRestoredBlueprintRun(novelId);
        hadTask = false;
      }
    };
    const unsubscribe = subscribeAgentTaskRecovery(sync);
    sync();
    return unsubscribe;
  }, [novelId]);

  // 生成启动（本页发起或刷新恢复）：自动弹出生成过程弹窗（生成中会出现需要作者确认的选择）
  useEffect(() => {
    if (run.novelId === novelId && run.status === "running") setShowStreamModal(true);
  }, [run.status, run.novelId, novelId]);

  // 生成结束（在本页完成，或切走后期间完成）→ 刷新版本列表，新版蓝图自动出现。
  // 判定用「状态变到 done/error」而非「running→非running」：生成可能经历 running→error→done
  //（如确认等待期任务被懒清理误标 error、随后 SSE 正常完成覆盖为 done），只认 running 起点
  // 会让 error→done 这步漏掉 load()，蓝图已落库但版本列表永不刷新。
  const prevStatus = useRef<BlueprintRunStatus>(run.status);
  useEffect(() => {
    const own = run.novelId === novelId;
    const justFinished = own && prevStatus.current !== run.status && (run.status === "done" || run.status === "error");
    if (justFinished) {
      void load();
    }
    prevStatus.current = run.status;
  }, [run.status, run.novelId, novelId, load]);

  // 生成结束（本页或后台完成）：刷新版本列表 + 关闭弹窗清空草稿 + 弹 Message 消息提示（居中靠上）。
  // Message 仅蓝图页可见；跨页完成时用户不在本页，由全局 Notification（右上角）提示，两者不重复。
  // 完成判定用「变到 done」而非「running→done」：覆盖 running→error→done（被懒清理误标又正常完成）路径。
  const prevRunStatus = useRef<BlueprintRunStatus>(run.status);
  useEffect(() => {
    const own = run.novelId === novelId;
    const prev = prevRunStatus.current;
    if (own && prev !== "done" && run.status === "done") {
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
      message.error(`蓝图生成失败：${friendlyTaskError(run.errMsg, "请稍后重试")}`);
    }
    prevRunStatus.current = run.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.novelId, novelId, run.errMsg, run.msg]);

  // 生成过程弹窗：流式滚动与思考折叠在公共组件 AgentStreamModal 内处理

  // 默认选中当前生效中的蓝图（无则回退第一条）；用户手动点选后以点选为准
  const selected = items.find((b) => b.id === selectedId) ?? items.find((b) => b.status === "active") ?? items[0] ?? null;

  /** 发起蓝图生成：校验输入与 AI 配置 → 草稿持久化 → 按「导入/手写」两种模式启动后台任务。
   *  成功判定：任务已交给后端即视为成功发起（run 进入 running，SSE 完成/失败由下方 status 监听 effect 统一提示）。 */
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
    // 顶部悬浮提示：蓝图开始生成（完成/失败由下方 status 监听 effect 提示）；生成过程弹窗已自动弹出
    message.success("蓝图正在生成中…");
    // 弹窗保持打开，生成期间输入锁定、导入/清除隐藏；生成过程弹窗自动弹出（右下「查看生成过程」可重开）
    // 取消尚未完成的骨架校验（结果不再需要）
    checkAbortRef.current?.abort();
    checkAbortRef.current = null;
  }

  /** 发起大纲骨架 LLM 语义校验：结果回来覆盖关键词初筛；完成时弹成功/失败提示（弹窗关闭也照常提示）。
   *  恢复场景（重开弹窗续跑）与导入共用此函数，避免重复逻辑。 */
  function runOutlineCheck(text: string) {
    // 取消上一次未完成的校验（如恢复时重复发起），再发起新请求
    checkAbortRef.current?.abort();
    const ctrl = new AbortController();
    checkAbortRef.current = ctrl;
    void checkOutlineSkeleton(novelId, text, ctrl.signal)
      .then((r) => {
        // 仅当本次请求仍是最新的才覆盖结果（防止清空/换文件后被旧结果污染）
        if (checkAbortRef.current !== ctrl) return;
        setOutlineCheck({ status: "done", source: "llm", modules: r.modules });
        if (r.modules.length > 0 && r.modules.every((m) => m.ok)) {
          message.success("AI 检查通过：大纲该有的内容都齐了，可直接生成蓝图");
        } else {
          const missing = r.modules.filter((m) => !m.ok).length;
          message.warning(`AI 检查完成：${missing} 项建议补上（可跳过，见弹窗提示）`);
        }
      })
      .catch(() => {
        // 用户主动取消（清空/生成）或请求中断（切页/刷新）时保持现状；
        // 仅当仍是最新请求才标 done，避免输入框一直锁定
        if (checkAbortRef.current === ctrl) setOutlineCheck((prev) => (prev ? { ...prev, status: "done" } : prev));
      });
  }

  /** 导入大纲文档：上传解析成功后将全文填入输入框并记录文件名，随后触发骨架检测
   *  （关键词初筛立即提示 + 后台 LLM 语义校验结果回来覆盖）。 */
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
      runOutlineCheck(res.text);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  /** 「已复制」短暂反馈：2 秒后恢复（复制成功与本地回退分支共用）。 */
  function flashCopied() {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  /** 一键复制大纲模板文本：优先拉取后端单一事实来源（与识别机制同步），失败回退本地缓存。 */
  async function handleCopyOutlineTemplate() {
    try {
      const tpl = await getOutlineTemplate();
      await copyText(tpl.text);
      flashCopied();
      message.success(`已复制大纲模板 ${tpl.version}`);
      return;
    } catch {
      // 网络/服务不可用时回退本地缓存模板，保证离线可用
    }
    try {
      await copyText(OUTLINE_TEMPLATE_TEXT);
      flashCopied();
      message.warning("已复制模板（网络不好，用的是备用版）");
    } catch {
      message.error("复制失败，请手动复制模板。");
    }
  }

  /** 清除导入的文档：取消进行中的骨架校验并清空输入框/导入名/校验状态（「清除导入」按钮回调）。 */
  function clearImport() {
    checkAbortRef.current?.abort();
    checkAbortRef.current = null;
    setInputText("");
    setImportName(null);
    setOutlineCheck(null);
  }

  /** 设为生效中：激活即把该蓝图内容注入写作/大纲/设定等页面，先弹风险确认框（新增蓝图一律手动激活）。 */
  function handleActivateClick(b: Blueprint) {
    setActivateTarget(b);
  }

  /** 执行激活：先置「激活中…」防重复点击 → 调后端接口。
   *  成功判定：后端返回 running=false 说明已生效（并发下其他请求已完成），无需轮询直接刷新；
   *  返回 running=true 则进入轮询，直到任务成功/失败才退出「激活中…」。 */
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
      message.success(`v${b.version} 已设为当前使用，设定和文风已跟随切换。`);
      void load();
      return;
    }
    // 后台激活进行中：轮询到成功/失败才退出「激活中…」（刷新/切页不中断）
    pollActivation(novelId);
  }

  /** 激活确认框回调：关闭确认框后执行激活（activatingId 非空说明已在激活，忽略本次点击）。 */
  async function confirmActivate() {
    if (!activateTarget || activatingId) return;
    const b = activateTarget;
    setActivateTarget(null);
    await doActivate(b);
  }

  async function handleDelete(b: Blueprint) {
    setDelTarget(b);
  }

  /** 执行删除：成功后若删的是当前选中项则清空选中、刷新列表；deleting 标志防重复提交。 */
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

  /** 关闭新增蓝图弹窗：不取消进行中的 AI 校验（继续跑，重开时进度/结果仍在），
   *  输入框内容与导入状态保留，重新进入时内容仍在（生成完成时才清空）。 */
  function closeAddModal() {
    setShowAddModal(false);
  }

  /** 打开新增蓝图弹窗：刷新/切页后组件重挂载，若存在持久化的导入会话则先恢复文档与校验状态；
   *  校验曾进行中（被关闭/切页/刷新打断）时自动续跑，进度条与成功/失败提示不再丢失。
   *  生成进行中不恢复（该场景由 draftKey 恢复草稿，避免干扰进行中的输入锁定）。 */
  function openAddModal() {
    if (!(run.novelId === novelId && run.status === "running")) {
      try {
        const raw = localStorage.getItem(importKey);
        if (raw) {
          const s = JSON.parse(raw) as {
            text?: string;
            importName?: string | null;
            outlineCheck?: OutlineCheckState | null;
          } | null;
          if (s?.text) {
            setInputText(s.text);
            setImportName(s.importName ?? null);
            if (s.outlineCheck) setOutlineCheck(s.outlineCheck);
            // 校验被打断（pending）：重开时自动续跑；同组件内校验仍在后台跑则不必重复发起
            if (s.outlineCheck?.status === "pending" && !checkAbortRef.current) {
              runOutlineCheck(s.text);
            }
          }
        }
      } catch {
        /* 忽略损坏数据 */
      }
    }
    setShowAddModal(true);
  }

  return (
    <Loading loading={loading} className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[300px_1fr] [grid-template-rows:minmax(0,1fr)]">
        <BlueprintVersionList
          items={items}
          selectedId={selected?.id ?? null}
          activatingId={activatingId}
          onAdd={openAddModal}
          onSelect={setSelectedId}
        />

        <section className="flex min-h-0 min-w-0 flex-col gap-5 sm:gap-7">
          <BlueprintDetail
            selected={selected}
            activatingId={activatingId}
            onActivate={handleActivateClick}
            onDelete={handleDelete}
          />
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
          title={activateTarget ? `将 v${activateTarget.version} 设为当前使用？` : "设为当前使用？"}
          message={`切到这一版后：\n1) 写正文、写大纲、写设定都会按这一版来；\n2) 之前那版里的设定先收起来，不会丢，随时能切回去；\n3) 已经写好的正文和章节不会动。\n\n要切换吗？`}
          confirmText="确定切换"
          tone="primary"
          onConfirm={confirmActivate}
          onCancel={() => setActivateTarget(null)}
        />

        <BlueprintAddModal
          open={showAddModal}
          onClose={closeAddModal}
          importName={importName}
          importing={importing}
          outlineCheck={outlineCheck}
          inputText={inputText}
          onInputChange={setInputText}
          onImportFile={handleImportFile}
          onClearImport={clearImport}
          copied={copied}
          onCopyTemplate={handleCopyOutlineTemplate}
          running={running}
          showStreamBtn={run.novelId === novelId && running}
          onShowStream={() => setShowStreamModal(true)}
          onGenerate={handleGenerate}
        />

        {/* ── 生成过程弹窗：DeepSeek 网页版同款交互（复用公共组件） ── */}
        <AgentStreamModal
          open={showStreamModal}
          onClose={() => setShowStreamModal(false)}
          title="AI 生成过程"
          running={running}
          draftText={run.draftText}
          thinkingText={run.thinkingText}
          error={run.status === "error"}
          elapsed={elapsed}
          novelId={novelId}
          emptyRunningText={
            "AI 正在思考整理，头1-3分钟通常没字，属正常，\n正文开始生成后会在这里实时滚动显示…"
          }
          emptyDoneText="生成完成，新蓝图已出现在版本列表，可关闭此弹窗查看。"
        />
      </div>
    </Loading>
  );
}
