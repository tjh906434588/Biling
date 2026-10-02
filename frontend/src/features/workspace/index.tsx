/**
 * @file features/workspace/index.tsx
 * 工作台页入口（原 app/workspace/[id]/page.tsx 的页面逻辑按 feature 归位；
 * app/workspace/[id]/page.tsx 仅负责解析路由参数后转发 novelId）。
 * 核心机制：tab 与 URL 双向同步（replaceState，刷新/复制链接保持），初始 tab 在 SSR 首帧直接从 URL 读取；
 * tools 调试页以沙箱模式（dry_run）运行 AI 角色，产出不落库，确认后点「加入正式库」才写入；
 * 首次进入弹路径引导通知（localStorage 记已读）；全局挂 AI 后台任务悬浮框与作者确认弹窗，跨 tab 常驻。
 * 结构：本文件保留全部 state/effect/handler；导航配置/图标/辅助函数在 components/workspace-config.tsx，
 * 顶栏/侧栏/标签条/tools 面板/路径引导为 components/ 下展示型子组件（数据经 props 传入、交互经回调上抛）。
 */
"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { runAgent, commitAgent, listNovels, type StreamEventData } from "@/lib/api";
import { AGENTS } from "@/constants";
import type { Tab } from "@/types/workspace";
import { AiNotReadyBanner, useAiStatus } from "@/lib/ai-status";
import SettingsPanel from "./settings";
import WritingPanel, { hideWorkspaceNotifs, showWorkspaceNotifs } from "./writing";
import OutlinePanel from "./outline";
import LedgerPanel from "./ledger";
import BlueprintPanel from "./blueprint";
import StylePanel from "./style";
import GraphPanel from "./graph";
import ModelsPanel from "./models";
import PromptsModal from "./components/prompts-modal";
import AgentTaskToasts from "./components/agent-task-toasts";
import AuthorConfirmHost from "@/components/author-confirm";
import { message } from "@/components/message";
import {
  AI_TABS,
  FLAT_TABS,
  defaultForm,
  type CommitItem,
  type LogItem,
} from "./components/workspace-config";
import FirstRunGuide from "./components/first-run-guide";
import Topbar from "./components/topbar";
import Sidebar from "./components/sidebar";
import TabStrip from "./components/tab-strip";
import ToolsPanel from "./components/tools-panel";

/** 工作台页组件：tab 切换 + 各功能区面板挂载 + tools 调试运行器（novelId 由路由页解析后传入）。 */
export default function Workspace({ novelId }: { novelId: string }) {
  const searchParams = useSearchParams();
  // 初始 tab 直接从 URL 读取：SSR 首帧就是目标页面，刷新无「先回蓝图再跳回」的闪回
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get("tab");
    return t && FLAT_TABS.some(([k]) => k === t) ? (t as Tab) : "blueprint";
  });
  // 以下状态均服务于 tools 调试页：当前角色、其表单值、运行中标志
  const [agent, setAgent] = useState("novelist");
  const [formValues, setFormValues] = useState<Record<string, string>>(() => defaultForm("novelist"));
  const [running, setRunning] = useState(false);
  /** SSE 事件日志（tools 页「事件流」面板数据源） */
  const [logs, setLogs] = useState<LogItem[]>([]);
  /** 运行完成的结构化结果（JSON 字符串，绿色面板展示） */
  const [result, setResult] = useState<string | null>(null);
  /** 顶栏书名：由 id 反查小说列表得到，避免显示一串 UUID */
  const [novelTitle, setNovelTitle] = useState<string>("");
  // 调试页恒为沙箱：运行只生成不写正式库，用户确认满意后点「加入正式库」才落库
  const [commitItems, setCommitItems] = useState<CommitItem[] | null>(null);
  const [committing, setCommitting] = useState(false);
  /** 运行中实时累积的生成文本（蓝色滚动预览框） */
  const [liveText, setLiveText] = useState("");
  /** 写作指令配置弹窗开关 */
  const [showPrompts, setShowPrompts] = useState(false);
  /** 实时预览框 DOM 引用（liveText 变化时自动滚到底部） */
  const liveBoxRef = useRef<HTMLDivElement | null>(null);
  /** 最近一次运行实际传给后端的 params（「加入正式库」时原样复用） */
  const lastParamsRef = useRef<Record<string, unknown>>({});
  /** 当前运行的 AbortController（「停止」按钮触发中断） */
  const abortRef = useRef<AbortController | null>(null);
  /** 日志自增序号（React key，保证唯一） */
  const logSeq = useRef(0);
  const { ensureReady } = useAiStatus();

  // 生成内容预览自动滚到底部
  useEffect(() => {
    const el = liveBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveText]);

  // 顶栏显示书名，而不是一串看不懂的 UUID
  useEffect(() => {
    let alive = true;
    listNovels()
      .then((list) => {
        if (alive) setNovelTitle(list.find((n) => n.id === novelId)?.title ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [novelId]);

  // 常驻/计时通知（「后续章节关系受影响」「联动重写中断」）只在当前小说工作台显示：
  // 进入本小说工作台恢复挂着的通知，离开（进入其他小说工作台/书架）即隐藏；各小说互相独立、数据保留。
  useEffect(() => {
    showWorkspaceNotifs(novelId);
    return () => {
      hideWorkspaceNotifs(novelId);
    };
  }, [novelId]);

  // tab 变化时同步到 URL（replaceState 不产生历史记录），刷新/复制链接均能保持
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "blueprint") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  /** 切换调试角色：重置表单值为该角色默认值，并清空上一角色的调试产出 */
  const selectAgent = (key: string) => {
    setAgent(key);
    setFormValues(defaultForm(key));
    setCommitItems(null);
  };

  /** 追加一条 SSE 事件日志（id 自增，保证每条 key 唯一） */
  const pushLog = useCallback((kind: LogItem["kind"], event: string, data: string) => {
    setLogs((prev) => [...prev, { id: ++logSeq.current, event, data, kind }]);
  }, []);

  /**
   * 以沙箱模式运行当前角色：AI 就绪校验 → 必填项校验 → 表单转后端 params → SSE 流式输出。
   * 产出不落库（dry_run），需用户确认后点「加入正式库」才写入正式库。
   */
  async function handleRun() {
    try {
      ensureReady();
    } catch (e) {
      setLogs([{ id: ++logSeq.current, event: "error", data: (e as Error).message, kind: "err" }]);
      setRunning(false);
      return;
    }
    // 必填项校验：没填就不运行，避免白消耗 Token
    const missing = AGENTS[agent].params
      .filter((p) => p.required && !(formValues[p.key] ?? "").trim())
      .map((p) => p.label);
    if (missing.length > 0) {
      message.error(`请先填写：${missing.join("、")}`);
      return;
    }
    setRunning(true);
    setResult(null);
    setLogs([]);
    setCommitItems(null);
    setLiveText("");
    logSeq.current = 0;
    let liveBuf = "";

    // 表单值 → 后端 params：留空的字段不传（后端有兜底），数字转 number、逗号分隔文本转数组
    const params: Record<string, unknown> = {};
    for (const p of AGENTS[agent].params) {
      const raw = (formValues[p.key] ?? "").trim();
      if (p.type === "select") {
        params[p.key] = raw || p.default;
      } else if (p.type === "number") {
        if (raw === "") continue; // 留空不传，后端自行排下一章等
        const n = Number(raw);
        params[p.key] = Number.isFinite(n) ? n : raw;
      } else if (p.key === "chapter_titles") {
        const titles = raw
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (titles.length > 0) params[p.key] = titles;
      } else if (raw !== "") {
        params[p.key] = raw;
      }
    }
    lastParamsRef.current = params;

    let parsed: unknown = null;
    const abort = new AbortController();
    abortRef.current = abort;

    const onEvent = (ev: StreamEventData) => {
      const s = JSON.stringify(ev.data, null, 2);
      if (ev.event === "stream_delta") {
        const d = ev.data as { delta: string };
        pushLog("delta", ev.event, d.delta);
        liveBuf += d.delta;
        setLiveText(liveBuf);
      } else if (ev.event === "schema_validate") {
        const ok = (ev.data as { status: string }).status === "ok";
        pushLog(ok ? "ok" : "err", ev.event, s);
      } else if (ev.event === "stored") {
        const d = ev.data as {
          action?: string;
          data?: Record<string, unknown>;
          versions?: { version: string; data: Record<string, unknown> }[];
        };
        pushLog("ok", ev.event, s);
        if (d.action === "dry_run") {
          // 沙箱模式：只展示产出，并记录可加入正式库的候选
          if (d.versions) {
            parsed = d.versions;
            setCommitItems(d.versions.map((v) => ({ source: v.version, output: v.data })));
          } else if (d.data) {
            parsed = d.data;
            setCommitItems([{ source: undefined, output: d.data }]);
          }
        } else {
          // 正式落库：整包事件数据即最终结果
          parsed = ev.data;
        }
      } else if (ev.event === "stream_error") {
        pushLog("err", ev.event, s);
      } else {
        pushLog("info", ev.event, s);
      }
    };

    try {
      await runAgent(agent, novelId, params, onEvent, abort.signal, true);
    } catch (e) {
      pushLog("err", "error", (e as Error).message);
    } finally {
      setRunning(false);
      if (parsed !== null) setResult(JSON.stringify(parsed, null, 2));
    }
  }

  /** 把某一版调试产出显式加入正式库 */
  async function handleCommit(item: CommitItem) {
    try {
      setCommitting(true);
      const r = await commitAgent(agent, novelId, lastParamsRef.current, item.output, item.source);
      message.success(item.source ? `已加入正式库：${r.action}（版本 ${item.source}）` : `已加入正式库：${r.action}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  /** 停止当前运行：中断 SSE 流并复位运行状态 */
  function handleStop() {
    abortRef.current?.abort();
    setRunning(false);
  }

  return (
    /* 应用壳：占满标题栏以下的剩余视口，页面本身不滚动，只有主画布内部滚动 */
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* ── 顶栏：48px 工具栏 ─────────────────────────────────── */}
      <Topbar novelTitle={novelTitle} />

      {/* 全局 AI 后台任务悬浮框：跨 tab 常驻，左上角进行中 / 右上角完成 */}
      <AgentTaskToasts novelId={novelId} tab={tab} />

      {/* 全局作者确认弹窗：生成流程在确认点暂停时弹出，跨 tab 常驻，刷新后自动恢复 */}
      <AuthorConfirmHost novelId={novelId} />

      {/* 写作指令配置弹窗（左下角入口，每部小说独立生效） */}
      <PromptsModal open={showPrompts} onClose={() => setShowPrompts(false)} novelId={novelId} />

      {/* ── 主体：侧栏 + 主画布 ───────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* 宽屏：IDE 式工具面板（图标 + 分组） */}
        <Sidebar tab={tab} onSelectTab={setTab} onOpenPrompts={() => setShowPrompts(true)} />

        {/* 中窄屏：可横滑标签条 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <TabStrip tab={tab} onSelectTab={setTab} />

          <main className="min-h-0 flex-1 overflow-hidden">
            <div
              className={`mx-auto flex h-full min-h-0 w-full flex-col overflow-y-auto px-4 py-6 sm:px-6 ${
                tab === "write" || tab === "outline" ? "max-w-[1728px]" : "max-w-[1280px]"
              }`}
            >
              {AI_TABS.has(tab) && <AiNotReadyBanner onConfigure={() => setTab("models")} />}
              <FirstRunGuide novelId={novelId} onGo={setTab} />
              {tab === "write" && <WritingPanel novelId={novelId} />}
              {tab === "settings" && <SettingsPanel novelId={novelId} />}
              {tab === "outline" && <OutlinePanel novelId={novelId} />}
              {tab === "ledger" && <LedgerPanel novelId={novelId} />}
              {tab === "blueprint" && <BlueprintPanel novelId={novelId} />}
              {tab === "style" && <StylePanel novelId={novelId} />}
              {tab === "graph" && <GraphPanel novelId={novelId} />}
              {tab === "models" && <ModelsPanel />}
              {tab === "tools" && (
                <ToolsPanel
                  agent={agent}
                  formValues={formValues}
                  running={running}
                  logs={logs}
                  result={result}
                  commitItems={commitItems}
                  committing={committing}
                  liveText={liveText}
                  liveBoxRef={liveBoxRef}
                  onSelectAgent={selectAgent}
                  onFormChange={(key, value) =>
                    setFormValues((prev) => ({ ...prev, [key]: value }))
                  }
                  onRun={handleRun}
                  onStop={handleStop}
                  onCommit={handleCommit}
                />
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
