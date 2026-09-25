"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { runAgent, commitAgent, listNovels, type StreamEventData } from "@/lib/api";
import { AiNotReadyBanner, CostHint, useAiStatus } from "@/lib/ai-status";
import SettingsPanel from "@/components/settings-panel";
import WritingPanel, { hideWorkspaceNotifs, showWorkspaceNotifs } from "@/components/writing-panel";
import OutlinePanel from "@/components/outline-panel";
import LedgerPanel from "@/components/ledger-panel";
import BlueprintPanel from "@/components/blueprint-panel";
import StylePanel from "@/components/style-panel";
import DetectPanel from "@/components/detect-panel";
import GraphPanel from "@/components/graph-panel";
import ModelsPanel from "@/components/models-panel";
import PromptsModal from "@/components/prompts-modal";
import AgentTaskToasts from "@/components/agent-task-toasts";
import AuthorConfirmHost from "@/components/author-confirm";
import { notification, removeNotification } from "@/components/notification";
import { message } from "@/components/message";

/* 六角色表单 schema：作者填中文表单，运行前自动转成后端认识的 params
 * 文本/数字/长文本不预填内容，只给占位提示（placeholder）；下拉框需有选中项故带 default。 */
type ParamType = "text" | "textarea" | "number" | "select";

interface ParamSpec {
  key: string; // 传给后端的字段名
  label: string; // 中文标签
  placeholder?: string; // 输入框占位提示（不预填内容）
  type: ParamType;
  default?: string | number; // 仅 select 使用（下拉框必须有选中项）
  optional?: boolean;
  required?: boolean; // 必填：为空时阻止运行并提示
  options?: { value: string; label: string }[];
}

const AGENTS: Record<string, { name: string; desc: string; params: ParamSpec[] }> = {
  blueprint_architect: {
    name: "蓝图师",
    desc: "搭建整部作品的世界蓝图（规则/人物弧光/分卷/伏笔计划）",
    params: [
      {
        key: "requirements",
        label: "创作要求",
        placeholder: "例如：悬疑奇幻，主题是记忆与身份，主角是记忆被篡改的占卜师之子",
        type: "textarea",
        required: true,
      },
    ],
  },
  outliner: {
    name: "大纲师",
    desc: "为某一章产出细化大纲（节拍/冲突/伏笔处理）",
    params: [
      { key: "chapter_no", label: "章节号", placeholder: "如 1（留空则排下一章）", type: "number" },
      {
        key: "chapter_titles",
        label: "已写章节标题",
        placeholder: "如：雨夜铜币, 通缉令…（逗号分隔，可留空）",
        type: "text",
        optional: true,
      },
    ],
  },
  novelist: {
    name: "小说家",
    desc: "按大纲生成章节正文（单版本，生成即定稿，见「写作」页）",
    params: [
      { key: "chapter_no", label: "章节号", placeholder: "如 1（留空则排下一章）", type: "number" },
      { key: "title", label: "章名", placeholder: "如 雨夜铜币", type: "text" },
      { key: "pov", label: "视角角色", placeholder: "如 林澈（这章跟谁走）", type: "text" },
      {
        key: "chapter_function",
        label: "章节功能",
        type: "select",
        default: "buildup",
        options: [
          { value: "buildup", label: "铺垫" },
          { value: "progression", label: "推进" },
          { value: "climax", label: "高潮" },
          { value: "turning", label: "转折" },
          { value: "interlude", label: "过渡" },
        ],
      },
      {
        key: "writing_mode",
        label: "写作模式",
        type: "select",
        default: "draft_free",
        options: [
          { value: "draft_free", label: "自由初稿（写到哪算哪）" },
          { value: "outline_guided", label: "按大纲走（完成目标）" },
        ],
      },
      {
        key: "outline",
        label: "本章大纲",
        placeholder: "粘贴本章大纲（留空则自由续写）…",
        type: "textarea",
      },
      {
        key: "goal",
        label: "本章目标",
        placeholder: "如 引入铜币并建立通缉危机（可留空）",
        type: "text",
        optional: true,
      },
    ],
  },
  extractor: {
    name: "提取师",
    desc: "从章节正文提取故事状态，写入记忆层（真实入库 story_state）",
    params: [
      { key: "chapter_no", label: "章节号", placeholder: "如 1", type: "number" },
      {
        key: "chapter_text",
        label: "本章正文",
        placeholder: "粘贴本章正文，AI 从中提取故事状态…",
        type: "textarea",
        required: true,
      },
      {
        key: "prev_state",
        label: "上一章状态",
        placeholder: "上一章故事状态（可留空）",
        type: "textarea",
        optional: true,
      },
    ],
  },
  critic: {
    name: "评价师",
    desc: "对照蓝图/伏笔账本评价章节质量，反哺小说家",
    params: [
      {
        key: "outline",
        label: "本章大纲",
        placeholder: "粘贴本章大纲（对照评价用）…",
        type: "textarea",
      },
      {
        key: "chapter_text",
        label: "待评价的正文",
        placeholder: "粘贴待评价的章节正文…",
        type: "textarea",
        required: true,
      },
      {
        key: "writing_mode",
        label: "写作模式",
        type: "select",
        default: "draft_free",
        options: [
          { value: "draft_free", label: "自由初稿" },
          { value: "outline_guided", label: "按大纲走" },
        ],
      },
    ],
  },
};

/** 生成某角色的初始表单值：文本类留空，下拉框取默认选中项 */
function defaultForm(agent: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const p of AGENTS[agent].params) {
    obj[p.key] = p.type === "select" ? String(p.default ?? "") : "";
  }
  return obj;
}

const AGENT_KEYS = Object.keys(AGENTS);

type Tab = "write" | "settings" | "outline" | "ledger" | "blueprint" | "style" | "detect" | "graph" | "models" | "tools";

/** 会调用 AI（消耗 Token）的 tab：只有这些页面需要显示"AI 未接入"横幅。
 *  设定/账本/检测/关系图等纯本地功能不在此列。 */
const AI_TABS: ReadonlySet<Tab> = new Set(["write", "outline", "blueprint", "style", "tools"]);

/* ── 导航：带图标、按流程分组，像 IDE 的活动栏 + 工具面板 ── */
const ICONS: Record<string, ReactNode> = {
  write: <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />,
  outline: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
  blueprint: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  settings: <path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" />,
  ledger: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></>,
  style: <><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 114.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 00-3-3.02z" /></>,
  graph: <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></>,
  detect: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  models: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>,
  tools: <path d="M4 17l6-6-6-6M12 19h8" />,
};

const NAV_GROUPS: { label: string; items: [Tab, string, keyof typeof ICONS][] }[] = [
  {
    label: "创作",
    items: [
      ["blueprint", "蓝图", "blueprint"],
      ["write", "写作", "write"],
    ],
  },
  {
    label: "资料",
    items: [
      ["settings", "设定", "settings"],
      ["ledger", "账本", "ledger"],
      ["style", "风格", "style"],
      ["graph", "图谱", "graph"],
    ],
  },
  {
    label: "质量与工具",
    items: [
      ["outline", "大纲（高级）", "outline"],
      ["detect", "体检", "detect"],
      ["models", "模型", "models"],
    ],
  },
];
const FLAT_TABS = NAV_GROUPS.flatMap((g) => g.items);

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      aria-hidden
      className="h-[15px] w-[15px] shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

interface LogItem {
  id: number;
  event: string;
  data: string;
  kind: "info" | "ok" | "err" | "delta";
}

/** 首次进入工作台的路径引导步骤：点步骤跳转对应页面（通知保持常驻），✕ 关闭后不再出现。
 *  大纲+章节合并后：写作直接由蓝图出发，写正文前弹「本章规划」确认，不再单独排大纲。 */
const GUIDE_STEPS: [Tab, string, string][] = [
  ["blueprint", "蓝图", "读设定，定全书骨架"],
  ["write", "写作", "写正文前确认本章规划，直接生成"],
];

/**
 * 首次进入工作台时的路径引导：右上角 Notification（常驻，duration=0）。
 * - 只有工作台页面才提醒：离开工作台路由时自动隐藏（不标记已读），回来重新展示；工作台内切 tab 常驻。
 * - 不自动消失、不被其他通知顶掉，只有点 ✕ 才关闭（标记已读，之后不再出现）。
 * - 点步骤按钮跳转对应页面（切 tab），通知保持常驻不关闭。
 */
function FirstRunGuide({ novelId, onGo }: { novelId: string; onGo: (t: Tab) => void }) {
  const notifIdRef = useRef<number | null>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(`biling.wsGuide.${novelId}`) === "1";
    } catch {
      /* 隐私模式下默认展示 */
    }
    if (seen) return;

    notifIdRef.current = notification.info({
      duration: 0, // 常驻：只有手动 ✕ 才关闭
      title: "第一次写这本书？按这个顺序走",
      message: (
        <>
          <p className="text-[12px] leading-5 text-zinc-500 dark:text-zinc-400">
            蓝图是全书宪法，从设定出发定骨架；写正文前会先弹出「本章规划」供你确认，确认后直接写作。
          </p>
          <ol className="mt-2 flex flex-col gap-1">
            {GUIDE_STEPS.map(([t, label, hint], i) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => onGo(t)}
                  title={hint}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[10px] text-white dark:bg-zinc-100 dark:text-zinc-900">
                    {i + 1}
                  </span>
                  {label}
                  <span className="ml-auto text-[11px] text-zinc-400">→</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ),
      onClose: () => {
        notifIdRef.current = null;
        // 仅用户手动 ✕ 关闭时标记已读；离开工作台页面的隐藏不算
        try {
          localStorage.setItem(`biling.wsGuide.${novelId}`, "1");
        } catch {
          /* 隐私模式下忽略 */
        }
      },
    });

    // 离开工作台页面（组件卸载）时隐藏通知，但不触发 onClose（不标记已读）；回来重新展示
    return () => {
      if (notifIdRef.current != null) {
        removeNotification(notifIdRef.current);
        notifIdRef.current = null;
      }
    };
  }, [novelId, onGo]);

  return null;
}

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  // 初始 tab 直接从 URL 读取：SSR 首帧就是目标页面，刷新无「先回蓝图再跳回」的闪回
  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get("tab");
    return t && FLAT_TABS.some(([k]) => k === t) ? (t as Tab) : "blueprint";
  });
  const [agent, setAgent] = useState("novelist");
  const [formValues, setFormValues] = useState<Record<string, string>>(() => defaultForm("novelist"));
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [novelTitle, setNovelTitle] = useState<string>("");
  // 调试页恒为沙箱：运行只生成不写正式库，用户确认满意后点「加入正式库」才落库
  const [commitItems, setCommitItems] = useState<
    { source?: string; output: Record<string, unknown> }[] | null
  >(null);
  const [committing, setCommitting] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [showPrompts, setShowPrompts] = useState(false);
  const liveBoxRef = useRef<HTMLDivElement | null>(null);
  const lastParamsRef = useRef<Record<string, unknown>>({});
  const abortRef = useRef<AbortController | null>(null);
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
        if (alive) setNovelTitle(list.find((n) => n.id === id)?.title ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  // 常驻/计时通知（「后续章节关系受影响」「联动重写中断」）只在当前小说工作台显示：
  // 进入本小说工作台恢复挂着的通知，离开（进入其他小说工作台/书架）即隐藏；各小说互相独立、数据保留。
  useEffect(() => {
    showWorkspaceNotifs(id);
    return () => {
      hideWorkspaceNotifs(id);
    };
  }, [id]);

  // tab 变化时同步到 URL（replaceState 不产生历史记录），刷新/复制链接均能保持
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "blueprint") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  }, [tab]);

  const selectAgent = (key: string) => {
    setAgent(key);
    setFormValues(defaultForm(key));
    setCommitItems(null);
  };

  const pushLog = useCallback((kind: LogItem["kind"], event: string, data: string) => {
    setLogs((prev) => [...prev, { id: ++logSeq.current, event, data, kind }]);
  }, []);

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
      } else if (ev.event === "version_start") {
        liveBuf += `\n—— 版本 ${(ev.data as { version: string }).version} ——\n`;
        pushLog("info", ev.event, s);
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
          parsed = ev.data;
        }
      } else if (ev.event === "stream_error") {
        pushLog("err", ev.event, s);
      } else {
        pushLog("info", ev.event, s);
      }
    };

    try {
      await runAgent(agent, id, params, onEvent, abort.signal, true);
    } catch (e) {
      pushLog("err", "error", (e as Error).message);
    } finally {
      setRunning(false);
      if (parsed !== null) setResult(JSON.stringify(parsed, null, 2));
    }
  }

  /** 把某一版调试产出显式加入正式库 */
  async function handleCommit(item: { source?: string; output: Record<string, unknown> }) {
    try {
      setCommitting(true);
      const r = await commitAgent(agent, id, lastParamsRef.current, item.output, item.source);
      message.success(item.source ? `已加入正式库：${r.action}（版本 ${item.source}）` : `已加入正式库：${r.action}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setRunning(false);
  }

  /* 导航项：宽屏侧栏用（图标+文字），窄屏标签条用（仅文字） */
  const sideItem = ([k, label, icon]: [Tab, string, keyof typeof ICONS]) => {
    const active = tab === k;
    return (
      <li key={k}>
        <button
          className={`relative flex w-full items-center gap-2.5 rounded-md py-[7px] pl-3 pr-2 text-left text-[13.5px] transition-colors ${
            active
              ? "bg-zinc-100 font-medium text-zinc-900"
              : "text-zinc-500 hover:bg-zinc-100/60 hover:text-zinc-900"
          }`}
          onClick={() => setTab(k)}
        >
          {active && (
            <span
              aria-hidden
              className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-seal"
            />
          )}
          <span className={active ? "text-seal" : "text-zinc-400"}>
            <NavIcon name={icon} />
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      </li>
    );
  };

  const stripItem = ([k, label]: [Tab, string, keyof typeof ICONS]) => {
    const active = tab === k;
    return (
      <button
        key={k}
        className={`shrink-0 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
          active
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        }`}
        onClick={() => setTab(k)}
      >
        {label}
      </button>
    );
  };

  return (
    /* 应用壳：占满视口，页面本身不滚动，只有主画布内部滚动 */
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* ── 顶栏：48px 工具栏 ─────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-paper/90 px-3 backdrop-blur-md">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          title="返回书架"
        >
          <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          <span className="hidden sm:inline">书架</span>
        </Link>

        <span aria-hidden className="h-4 w-px shrink-0 bg-zinc-300" />

        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-[14.5px] font-medium leading-tight text-zinc-900">
            {novelTitle || "未命名作品"}
          </h1>
        </div>

        <span className="hidden items-center gap-1.5 font-mono text-[11px] text-zinc-400 md:flex">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-jade" />
          本地运行
        </span>
      </header>

      {/* 全局 AI 后台任务悬浮框：跨 tab 常驻，左上角进行中 / 右上角完成 */}
      <AgentTaskToasts novelId={id} tab={tab} />

      {/* 全局作者确认弹窗：生成流程在确认点暂停时弹出，跨 tab 常驻，刷新后自动恢复 */}
      <AuthorConfirmHost novelId={id} />

      {/* 写作指令配置弹窗（左下角入口，每部小说独立生效） */}
      <PromptsModal open={showPrompts} onClose={() => setShowPrompts(false)} novelId={id} />

      {/* ── 主体：侧栏 + 主画布 ───────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* 宽屏：IDE 式工具面板（图标 + 分组） */}
        <aside
          className="hidden w-[188px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-zinc-200 bg-sunken/40 px-2.5 py-4 xl:flex"
          aria-label="工作台导航"
        >
          {NAV_GROUPS.map((g) => (
            <div key={g.label}>
              <p className="mb-1.5 px-3 text-[10.5px] tracking-[0.22em] text-zinc-400">{g.label}</p>
              <ul className="flex flex-col gap-0.5">{g.items.map(sideItem)}</ul>
            </div>
          ))}

          <div className="mt-auto flex flex-col gap-2 px-2.5 pb-2">
            <button
              type="button"
              onClick={() => setShowPrompts(true)}
              title="配置各角色的写作指令（全局）"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800"
            >
              <svg
                aria-hidden
                className="h-[15px] w-[15px] shrink-0 text-zinc-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              写作指令
            </button>
            <p className="px-2 text-[10.5px] leading-4 text-zinc-400">
              设定「不可变」AI 必守<br />大纲批准自动入表
            </p>
          </div>
        </aside>

        {/* 中窄屏：可横滑标签条 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <nav
            className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200/70 bg-sunken/30 px-3 py-2 xl:hidden"
            aria-label="工作台导航"
          >
            {FLAT_TABS.map(stripItem)}
          </nav>

          <main className={`min-h-0 flex-1 ${tab === "settings" ? "overflow-hidden" : "overflow-y-auto"}`}>
            <div className={`mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 ${tab === "settings" ? "flex h-full flex-col" : ""}`}>
              {AI_TABS.has(tab) && <AiNotReadyBanner onConfigure={() => setTab("models")} />}
              <FirstRunGuide novelId={id} onGo={setTab} />
              {tab === "write" && <WritingPanel novelId={id} />}
              {tab === "settings" && <SettingsPanel novelId={id} />}
              {tab === "outline" && <OutlinePanel novelId={id} />}
              {tab === "ledger" && <LedgerPanel novelId={id} />}
              {tab === "blueprint" && <BlueprintPanel novelId={id} />}
              {tab === "style" && <StylePanel novelId={id} />}
              {tab === "detect" && <DetectPanel novelId={id} />}
              {tab === "graph" && <GraphPanel novelId={id} />}
              {tab === "models" && <ModelsPanel />}
              {tab === "tools" && (
                <div className="grid w-full gap-6 lg:grid-cols-[260px_1fr]">
                  {/* 角色选择 */}
                  <aside>
                    <h2 className="mb-2 text-sm font-semibold text-zinc-500">选择角色</h2>
                    <ul className="flex flex-col gap-2">
                      {AGENT_KEYS.map((key) => (
                        <li key={key}>
                          <button
                            className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                              agent === key
                                ? "border-zinc-500 bg-zinc-100 dark:border-zinc-500 dark:bg-zinc-800"
                                : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                            }`}
                            onClick={() => selectAgent(key)}
                          >
                            <div className="text-sm font-medium">{AGENTS[key].name}</div>
                            <div className="mt-0.5 text-xs text-zinc-500">{AGENTS[key].desc}</div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </aside>

                  {/* 参数 + 运行 */}
                  <section className="flex flex-col gap-4">
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-zinc-500">
                          {AGENTS[agent].name} · 运行参数
                        </h2>
                        <div className="flex gap-2">
                          {running ? (
                            <button
                              className="btn btn-ghost border-red-300 text-red-700 hover:border-red-400 hover:text-red-800 dark:border-red-900 dark:text-red-300"
                              onClick={handleStop}
                            >
                              停止
                            </button>
                          ) : (
                            <>
                              <button className="btn btn-primary px-4 py-1.5" onClick={handleRun}>
                                运行
                              </button>
                              <CostHint />
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
                        {AGENTS[agent].params.map((p) => {
                          const val = formValues[p.key] ?? "";
                          const setVal = (v: string) =>
                            setFormValues((prev) => ({ ...prev, [p.key]: v }));
                          return (
                            <label key={p.key} className="flex flex-col gap-1.5">
                              <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
                                {p.label}
                                {p.optional && (
                                  <span className="ml-1.5 text-[11px] font-normal text-zinc-400">
                                    （可选）
                                  </span>
                                )}
                              </span>
                              {p.type === "select" ? (
                                <select
                                  value={String(val)}
                                  onChange={(e) => setVal(e.target.value)}
                                  className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                >
                                  {p.options?.map((o) => (
                                    <option key={o.value} value={o.value}>
                                      {o.label}
                                    </option>
                                  ))}
                                </select>
                              ) : p.type === "textarea" ? (
                                <textarea
                                  value={String(val)}
                                  placeholder={p.placeholder}
                                  onChange={(e) => setVal(e.target.value)}
                                  rows={p.key === "chapter_text" || p.key === "user_message" ? 4 : 2}
                                  className="resize-y rounded-md border border-zinc-300 bg-white p-2.5 text-[13px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                />
                              ) : p.type === "number" ? (
                                <input
                                  type="number"
                                  value={String(val)}
                                  placeholder={p.placeholder}
                                  onChange={(e) => setVal(e.target.value)}
                                  className="w-40 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[13px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                />
                              ) : (
                                <input
                                  type="text"
                                  value={String(val)}
                                  placeholder={p.placeholder}
                                  onChange={(e) => setVal(e.target.value)}
                                  className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-[13px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                                />
                              )}
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    {/* 调试产出（未入库）：运行中实时滚动预览；完成后展示结构化结果 + 加入正式库 */}
                    <div>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-sm font-semibold text-zinc-500">调试产出（未入库）</h2>
                        {running ? (
                          <span className="text-[11.5px] text-blue-500">
                            生成中… {liveText.length} 字
                          </span>
                        ) : commitItems && commitItems.length > 0 ? (
                          <span className="text-[11.5px] text-zinc-400">
                            满意后点击「加入正式库」才会写入
                          </span>
                        ) : null}
                      </div>
                      {running && liveText && (
                        <div
                          ref={liveBoxRef}
                          className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-blue-200 bg-blue-50 p-3 text-[13px] leading-6 text-zinc-800 dark:border-blue-900 dark:bg-blue-950 dark:text-zinc-200"
                        >
                          {liveText}
                        </div>
                      )}
                      {result && (
                        <>
                          {commitItems && commitItems.length > 0 && (
                            <div className="mb-3 flex flex-wrap items-center gap-2">
                              {commitItems.map((item) => (
                                <button
                                  key={item.source ?? "single"}
                                  type="button"
                                  disabled={committing}
                                  onClick={() => handleCommit(item)}
                                  className="btn btn-primary px-3 py-1.5 disabled:opacity-60"
                                >
                                  {item.source
                                    ? `把这版（${item.source}）加入正式库`
                                    : "把这版加入正式库"}
                                </button>
                              ))}
                            </div>
                          )}
                          <pre className="overflow-x-auto rounded-lg border border-green-200 bg-green-50 p-3 text-xs dark:border-green-900 dark:bg-green-950">
                            {result}
                          </pre>
                        </>
                      )}
                      {!running && !result && (
                        <p className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3 text-[12.5px] text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
                          点击「运行」后，生成内容会实时滚动显示在这里；确认满意再点「加入正式库」写入。
                        </p>
                      )}
                    </div>

                    {/* 事件流 */}
                    <div className="flex flex-col">
                      <h2 className="mb-2 text-sm font-semibold text-zinc-500">
                        SSE 事件流
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-normal text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          context_ready → stream_delta* → schema_validate → stored
                        </span>
                      </h2>
                      <div className="h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-900">
                        {logs.length === 0 ? (
                          <p className="text-zinc-400">点击「运行」开始流式生成…</p>
                        ) : (
                          logs.map((l) => (
                            <div key={l.id} className="mb-1.5 whitespace-pre-wrap break-all">
                              <span
                                className={`mr-1.5 rounded px-1 py-0.5 text-[10px] ${
                                  l.kind === "ok"
                                    ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                                    : l.kind === "err"
                                      ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                                      : l.kind === "delta"
                                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                                        : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                                }`}
                              >
                                {l.event}
                              </span>
                              <span className="text-zinc-700 dark:text-zinc-300">{l.data}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
