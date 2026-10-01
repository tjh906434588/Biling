/**
 * @file writing-panel.tsx
 * 写作页主面板：状态编排 + 组合各子块。承担全局状态与 AI 流程编排（章节/版本/正文编辑、
 * AI 生成/评价/优化/提取/联动重写），渲染子块按职责拆到 writing/ 目录：
 * - notifications.ts：模块级全局通知机制（受影响章节 / 联动重写中断 / 设定自检），跨页存活；
 * - chapter-tree.tsx：左侧章节目录栏（卷分组/搜索/折叠 + 本章操作）；
 * - version-tree.tsx：版本树浮层（多级递归）；
 * - review-card.tsx：评价师结果卡片；
 * - auto-textarea.tsx：自动增高文本框。
 * 核心机制（保持不变）：
 * - AI 流程（生成/评价/优化/提取）走 runAgent SSE，任务跨页/刷新由全局 AgentTaskToasts 轮询恢复；
 * - 正文编辑「镜像 ref + 防抖 2s 自动落盘 + 切版本/卸载兜底落盘」，切章用请求序号防竞态覆盖；
 * - liveNovelRef + mountedRef 跨小说/卸载守卫 + 模块级通知状态（writing/notifications），
 *   保证切页不误弹、跨页通知不丢。
 */
"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  getActiveBlueprint,
  getAgentRunningTask,
  getChapter,
  listChapters,
  listOutlines,
  listReviews,
  runAgent,
  selectVersion,
  updateChapterVersion,
  type AgentRunningTaskResult,
  type ChapterDetail,
  type ChapterListItem,
  type Outline,
  type QualityReview,
  type SettingGap,
  type StreamTaskInfo,
} from "@/lib/api";
import InfoTip from "./info-tip";
import Modal from "./modal";
import ConfirmDialog from "./confirm-dialog";
import AgentStreamModal from "./agent-stream-modal";
import { useElapsed } from "@/lib/use-elapsed";
import Loading from "@/components/loading";
import { message } from "@/components/message";
import { CostHint, useAiStatus } from "@/lib/ai-status";
import {
  FUNCTIONS,
  REVIEW_W_DEFAULT,
  REVIEW_W_KEY,
  REVIEW_W_MAX,
  REVIEW_W_MIN,
  REVIEW_W_PRESETS,
  type VolumeInfo,
} from "@/constants";
import { copyText } from "@/utils/clipboard";
import { getRunningTask, subscribeRunningTask } from "@/lib/task-status";
import { AutoTextarea } from "./writing/auto-textarea";
import { ChapterSidebar, sourceLabel } from "./writing/chapter-tree";
import { ReviewCard } from "./writing/review-card";
import { VersionTree } from "./writing/version-tree";
import {
  clearGapNotifIfMismatch,
  fireGapNotif,
  getInitialAffectedChapters,
  getInitialRewriteFail,
  syncAffectedNotif,
  useRewriteFailNotif,
  type AffectedChapter,
  type RewriteFailData,
} from "./writing/notifications";
export { hideWorkspaceNotifs, showWorkspaceNotifs } from "./writing/notifications";

interface Props {
  novelId: string;
}

interface GenForm {
  chapter_no: number;
  title: string;
  outline: string;
  chapter_function: string;
  goal: string;
  reader_knows: string;
  protagonist_knows: string;
  must_hide: string;
  hint_only: string;
}

/** AI 运行过程状态：供「查看 AI 过程」弹窗流式展示（thinking=思考过程 / output=正式输出）。 */
interface AiRunState {
  thinking: string;
  output: string;
  running: boolean;
}

const EMPTY_FORM: GenForm = {
  chapter_no: 1,
  title: "",
  outline: "",
  chapter_function: "", // 留空 = 由小说家按剧情节奏自动判定（与大纲页一致）
  goal: "",
  reader_knows: "",
  protagonist_knows: "",
  must_hide: "",
  hint_only: "",
};

export default function WritingPanel({ novelId }: Props) {
  // 组件实例被 App Router 跨小说复用：记录「当前正在显示的小说」，AI 流回调/收尾据此判断是否已切小说
  const liveNovelRef = useRef(novelId);
  useEffect(() => {
    liveNovelRef.current = novelId;
  }, [novelId]);
  /** 挂载标记：切页签会卸载本面板，但 runAgent 的流回调仍在后台继续。
   *  卸载后不再弹全局 Message（居中的成功/告警提示），避免「切到其他页面完成」时
   *  和全局右上角 Notification 重复弹两条；跨页的完成提醒由 agent-task-toasts 兜底。
   *  注意：必须「挂载时置 true、卸载时置 false」。若像以前那样初始 true 且只在卸载置 false，
   *  React StrictMode 开发模式的「挂载→模拟卸载→重新挂载」会把 ref 永久钉在 false，
   *  导致本面板所有 AI 流回调被守卫吞掉（弹窗只见占位文字、完成无提示、列表不刷新）。 */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 初始数据（章节目录 / 已批准大纲 / 卷结构）加载中：遮罩过渡
  const [loading, setLoading] = useState(true);
  /** 章节目录列表（后端为单一事实来源：生成/定稿/提取/联动重写后重新拉取）。 */
  const [chapters, setChapters] = useState<ChapterListItem[]>([]);
  /** 当前生效蓝图的卷列表：章节目录按卷分组、可展开/搜索（与大纲页一致）。 */
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  /** 章节目录搜索词（按章号/标题过滤）。 */
  const [chapterSearch, setChapterSearch] = useState("");
  /** 被折叠的卷 key（默认全展开）。搜索时强制展开匹配卷。 */
  const [collapsedVols, setCollapsedVols] = useState<Record<string, boolean>>({});
  /** 当前激活章号（目录高亮 + 详情加载依据；进入页面默认最新一章，任务完成自动切到对应章）。 */
  const [activeNo, setActiveNo] = useState<number | null>(null);
  /** 当前章详情（全部版本 + 元数据）；正文未生成（404）时为 null。 */
  const [detail, setDetail] = useState<ChapterDetail | null>(null);
  /** 新增/重新生成弹窗表单：章号/标题/大纲目标/章节功能/信息控制（打开弹窗时重置）。 */
  const [form, setForm] = useState<GenForm>(EMPTY_FORM);
  /** 「沿用该章已批大纲」开关：仅该章有已批大纲时在弹窗显示；关 = 自由草稿（不预填大纲）。 */
  const [useOutline, setUseOutline] = useState(true);
  /** 正文生成进行中标志：驱动按钮禁用、AI 过程弹窗开关与刷新恢复轮询（见 mount 恢复 effect）。 */
  const [generating, setGenerating] = useState(false);
  /** 正上方悬浮条已迁移到全局 Message：showToast 为本地别名，统一走 message API。 */
  const showToast = (msg: string, level: "success" | "warning" | "error" = "success") => {
    if (level === "error") message.error(msg);
    else if (level === "warning") message.warning(msg);
    else message.success(msg);
  };
  /** 记忆层提取进行中标志：参与 aiBusy 锁定面板（目录/版本/其他 AI 操作全部禁用，提取完成才解除）。 */
  const [extracting, setExtracting] = useState(false);
  /** 本次提取清掉的「链条中间环」所影响的下游章节（如删了第1章 师徒，第2/3章递进前提断裂）。
   *  提取回执带 downstream_affected 时置位，弹出右上角全局 Notification 提示作者「挨个重写并重提取」；
   *  暂不处理（✕）/开始处理后清空。切页后通知保持显示，回来时从模块级状态还原（不会因切页丢失）。 */
  const [affectedChapters, setAffectedChapters] = useState<AffectedChapter[] | null>(() =>
    getInitialAffectedChapters(novelId),
  );
  /** 串行联动重写中断（任一章重写或提取失败即停止）：记录失败章 + 仍未完成的章节，
   *  弹右上角 error 通知分章列出「正文未重写 / 记忆层未提取」，让作者手动逐章补齐。
   *  初始状态还原模块级数据（切页回来），刷新则从 localStorage 恢复。 */
  const [rewriteFail, setRewriteFail] = useState<RewriteFailData | null>(() => getInitialRewriteFail(novelId));
  /** 当前章已批大纲（评价对照、正文-大纲版本关联、旧大纲判定 isStaleForActiveOutline 的依据）。 */
  const [approvedOutline, setApprovedOutline] = useState<Outline | null>(null);
  /** 全书已批大纲列表（按章号排序）：供「沿用该章已批大纲」回填、联动重写按章取大纲使用。 */
  const [approvedOutlines, setApprovedOutlines] = useState<Outline[]>([]);
  /** 评价进行中标志：参与 aiBusy 锁定面板 + 评价按钮禁用 + 评价过程弹窗开关。 */
  const [reviewing, setReviewing] = useState(false);
  /** 优化进行中标志：参与 aiBusy 锁定面板 + 优化按钮禁用 + 优化过程弹窗开关。 */
  const [revising, setRevising] = useState(false);
  /** AI 运行过程弹窗显隐（「查看 AI 过程」按钮打开；生成/评价/优化启动或刷新恢复时自动弹开）。 */
  const [showGenRun, setShowGenRun] = useState(false);
  const [showReviewRun, setShowReviewRun] = useState(false);
  const [showReviseRun, setShowReviseRun] = useState(false);
  // AI 流程启动（发起或刷新恢复）：自动弹出对应「AI 过程」弹窗（生成中会出现需要作者确认的选择）
  useEffect(() => {
    if (generating) setShowGenRun(true);
  }, [generating]);
  useEffect(() => {
    if (reviewing) setShowReviewRun(true);
  }, [reviewing]);
  useEffect(() => {
    if (revising) setShowReviseRun(true);
  }, [revising]);
  /** 当前章全部评价（接口按时间倒序；null=加载失败）。按选中版本过滤得到 currentReviews。 */
  const [reviews, setReviews] = useState<QualityReview[] | null>(null);
  /** AI 运行过程（「查看 AI 过程」弹窗）：生成正文 / 评价 / 优化各一份，任务结束保留供回看。 */
  const [genRun, setGenRun] = useState<AiRunState | null>(null);
  const [reviewRun, setReviewRun] = useState<AiRunState | null>(null);
  const [reviseRun, setReviseRun] = useState<AiRunState | null>(null);

  /** 各 AI 流程开始时间戳：供 AgentStreamModal 统计已用秒数（与蓝图/大纲页一致）。 */
  const [genStartAt, setGenStartAt] = useState<number | null>(null);
  const [reviewStartAt, setReviewStartAt] = useState<number | null>(null);
  const [reviseStartAt, setReviseStartAt] = useState<number | null>(null);
  /** 各 AI 流程已耗时（仅对应流程 running 期间走表，供各自「查看 AI 过程」弹窗展示）。 */
  const genElapsed = useElapsed(genRun?.running ?? false, genStartAt);
  const reviewElapsed = useElapsed(reviewRun?.running ?? false, reviewStartAt);
  const reviseElapsed = useElapsed(reviseRun?.running ?? false, reviseStartAt);

  /** 记忆层提取时记录：提取的是哪一章的哪个版本（id）。用于判断「当前正文」是否与提取的不一致，
   *  一致则无需重提取，不一致则高亮「提取→记忆层」按钮提醒用户重新提取。
   *  按章节隔离：切换章节后只对当前章做对比，不会把上一章的提取状态误带到本章。 */
  const [extractedChapterNo, setExtractedChapterNo] = useState<number | null>(null);
  const [extractedVersionId, setExtractedVersionId] = useState<string | null>(null);
  /** 版本预览选中（本地态，不触发激活）：点版本 tab 切换预览的版本。
   *  null = 走默认规则（有已定稿版本选已定稿版；全部未定稿选最新版）。
   *  生成新草稿后不自动切换选中，只弹提示；切章/刷新详情时重置。 */
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  /** 正文就地编辑（M：作者可直接改当前选中版本正文）。
   *  - editText：编辑区当前内容（来源=选中版本 content，改动后为本地草稿）；
   *  - lastSavedTextRef：最近一次已落库的文本（判断「是否有未保存改动」）；
   *  - saveState：saved=无改动 / dirty=有改动未保存 / saving=正在保存；
   *  - editTargetRef：当前编辑目标（章节号 + 版本 id），切版本/卸载时据此把旧编辑落盘。 */
  const [editText, setEditText] = useState("");
  const editTextRef = useRef("");
  const lastSavedTextRef = useRef("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  /** 正文在最近一次评价后是否被修改过：已有评价对应当前内容过期 → 评价栏出现「重新评价」提示。
   *  编辑即置 true；完成重新评价（评价期间无新增改动）或切换版本后置 false。 */
  const [reviewStale, setReviewStale] = useState(false);
  /** 已评价基线内容：评价所基于的版本正文。编辑保存后若内容与它一致（改完又恢复原样），
   *  说明现有评价仍然有效 → 撤销「重新评价」提示；重新评价完成或切换版本时更新为最新基准。 */
  const reviewBaselineRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const editTargetRef = useRef<{ chapterNo: number; versionId: string } | null>(null);

  /** 立即落盘当前未保存编辑（防抖触发 / AI 操作前 / 切版本 / 卸载时复用）。返回落库后的文本。 */
  const flushSave = useCallback(async (): Promise<string | null> => {
    const target = editTargetRef.current;
    if (!target) return null;
    const text = editTextRef.current;
    if (text === lastSavedTextRef.current) return text; // 无改动
    setSaveState("saving");
    try {
      const updated = await updateChapterVersion(novelId, target.chapterNo, target.versionId, { content: text });
      // 竞态守卫：保存期间用户又改了 → 本次结果不标记 saved（保持 dirty，防抖会再保存），
      // 且不回填旧文本到详情，避免旧内容覆盖新内容
      if (editTextRef.current === text) {
        lastSavedTextRef.current = updated.content;
        setSaveState("saved");
        // 落盘内容与已评价基线一致（改动后又恢复原样）→ 现有评价仍有效，撤销「重新评价」提示
        if (reviewBaselineRef.current != null && updated.content === reviewBaselineRef.current) {
          setReviewStale(false);
        }
        setDetail((d) =>
          d
            ? { ...d, versions: d.versions.map((v) => (v.id === target.versionId ? { ...v, content: updated.content } : v)) }
            : d,
        );
      }
      return updated.content;
    } catch (e) {
      setSaveState("dirty");
      showToast((e as Error).message, "error");
      return null;
    }
  }, [novelId]);

  // 弹窗开关：新增章节 / 信息控制 仍用弹窗；评价与优化、版本树已改为右侧常驻内联面板（见下方）
  const [showAddModal, setShowAddModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  /** 二次确认弹窗（定稿 / 提取记忆层）：用页面内自定义弹窗替代 window.confirm，
   *  规避 IDE 内嵌浏览器对原生 confirm 对话框的处理异常（原生弹窗挂起会导致页面卡死/跳转报错）。 */
  const [confirmDialog, setConfirmDialog] = useState<{
    kind: "finalize" | "finalize-force" | "extract";
    /** 定稿前已落盘保存的正文（flushSave 结果）；null=无编辑或保存失败 */
    savedText: string | null;
  } | null>(null);
  /** 评价与优化侧栏折叠：折叠后正文恢复全宽阅读，再点窄条展开 */
  const [reviewCollapsed, setReviewCollapsed] = useState(false);
  /** 评价栏宽度（px）：窄/中/宽三档预设切换，xl 起生效。偏好存 localStorage，跨刷新保持。 */
  const [reviewWidth, setReviewWidth] = useState(REVIEW_W_DEFAULT);

  // 读取/保存评价栏宽度偏好（localStorage 不可用时静默退化为默认值）
  useEffect(() => {
    try {
      const v = Number(window.localStorage.getItem(REVIEW_W_KEY));
      if (Number.isFinite(v) && v >= REVIEW_W_MIN && v <= REVIEW_W_MAX) setReviewWidth(v);
    } catch {
      /* localStorage 不可用：用默认宽度 */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(REVIEW_W_KEY, String(Math.round(reviewWidth)));
    } catch {
      /* 忽略：写不进去不影响本次使用 */
    }
  }, [reviewWidth]);

  /** 版本树：标题旁版本号点击展开的内联浮层（替代原弹窗）。 */
  const [versionOpen, setVersionOpen] = useState(false);
  /** 重新生成模式：非 null 时新增章节弹窗以"重新生成当前章正文"语义工作（章节号锁定当前章）。 */
  const [regenerateNo, setRegenerateNo] = useState<number | null>(null);
  /** 当前进行中的生成是「新增章节」还是「重新生成正文」：弹窗被手动关闭后 regenerateNo 会重置为 null，
   *  不能据此判断本次生成模式，用 state 记录（按钮禁用/提示在渲染期读取，用 ref 会触发
   *  react-hooks/refs 告警且不触发重渲染）。 */
  const [genIsRegenerate, setGenIsRegenerate] = useState(false);

  /** 信息控制弹窗：本地 draft，点「完成」才提交到 form，点「取消」丢弃。
   *  这样「清空」只清本地草稿，不点确定则原内容仍然保留（再打开还在）。 */
  const [infoDraft, setInfoDraft] = useState<{
    reader_knows: string;
    protagonist_knows: string;
    must_hide: string;
    hint_only: string;
  }>({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
  const openInfoModal = useCallback(() => {
    setInfoDraft({
      reader_knows: form.reader_knows,
      protagonist_knows: form.protagonist_knows,
      must_hide: form.must_hide,
      hint_only: form.hint_only,
    });
    setShowInfoModal(true);
  }, [form]);

  /** AI 服务状态检查：各 AI 操作发起前确认模型已配置可用，未配置则抛错拦截（避免发起注定失败的空请求）。 */
  const { ensureReady } = useAiStatus();

  /** 将已批大纲压缩成一段可作 outline 参数 / 评价对照的摘要（不含标题，标题单独成字段）。 */
  function summarizeOutline(o: Outline): string {
    const c = (o.content ?? {}) as {
      goal?: string;
      beats?: Array<{ content?: string }>;
      plant_foreshadowing?: Array<{ desc?: string; latest_payoff_chapter?: number }>;
      resolve_foreshadowing?: Array<{ how?: string }>;
    };
    const parts: string[] = [];
    if (c.goal) parts.push(`目标：${c.goal}`);
    if (c.beats?.length) parts.push(`节拍：${c.beats.map((b) => b.content).filter(Boolean).join("；").slice(0, 400)}`);
    if (c.plant_foreshadowing?.length)
      parts.push(`埋设：${c.plant_foreshadowing.map((p) => p.desc).join("、")}`);
    if (c.resolve_foreshadowing?.length)
      parts.push(`回收：${c.resolve_foreshadowing.map((r) => r.how).join("、")}`);
    return parts.join("\n");
  }

  /**
   * 目录里「最新一章」的下一章号：新增永远只追加最新的一章，不允许跳号或回填旧章。
   * 大纲+章节合并后不再要求该章有已批大纲：写正文前由「本章规划」弹窗确认，确认后直接写作。
   */
  const maxChapterNo = chapters.reduce((m, c) => Math.max(m, c.chapter_no), 0);
  const nextNo = maxChapterNo + 1;
  /** 目标章已批大纲：弹窗「沿用该章已批大纲」开关与回填的依据（仅该章有已批大纲时显示开关）。 */
  const targetOutline = approvedOutlines.find((o) => o.chapter_no === form.chapter_no) ?? null;
  // 大纲+章节合并后：写正文前由「本章规划」弹窗确认（后端 novelist 前置钩子），
  // 不再要求该章必须有已批大纲——有则自动回填预览，无则规划确认后直接写作。
  const canAdd = true;
  /** 信息控制已填项数：弹窗入口按钮据此显示「已填 N 项 · 编辑」。 */
  const infoFilledCount = [form.reader_knows, form.protagonist_knows, form.must_hide, form.hint_only].filter(
    (v) => v.trim(),
  ).length;

  /** 当前预览选中的正文版本：决定正文区显示、复制/提取/评价的对象、顶部「定稿」按钮目标。
   *  默认规则——有已定稿版本选已定稿版；全部未定稿选最新版；点版本 tab 可本地切换预览。 */
  const selectedVersion =
    (selectedVersionId != null
      ? (detail?.versions.find((v) => v.id === selectedVersionId) ?? null)
      : null) ??
    (detail?.versions.find((v) => v.is_active) ?? detail?.versions[detail.versions.length - 1] ?? null);
  /** 选中版本是否为已定稿（激活）版本：决定「定稿」/「提取」按钮是否可用。 */
  const selectedIsFinal = selectedVersion?.is_active ?? false;

  // ── 正文就地编辑：镜像 ref + 切版本落盘 + 防抖自动保存 + 卸载兜底 ──
  /** 编辑区内容镜像到 ref：防抖保存 / AI 操作前落盘读到的永远是最新输入。 */
  useEffect(() => {
    editTextRef.current = editText;
  }, [editText]);

  /** 选中版本变化：先把上一版本未保存的编辑静默落盘，再切换编辑目标到新版本内容。 */
  useEffect(() => {
    const old = editTargetRef.current;
    if (old && editTextRef.current !== lastSavedTextRef.current) {
      const text = editTextRef.current;
      void updateChapterVersion(novelId, old.chapterNo, old.versionId, { content: text })
        .then((v) => {
          // 期间已切走（editTarget 已换）则不更新 lastSaved，避免把旧文本当新目标已保存
          if (editTargetRef.current?.versionId === old.versionId) lastSavedTextRef.current = v.content;
          setDetail((d) =>
            d
              ? { ...d, versions: d.versions.map((x) => (x.id === old.versionId ? { ...x, content: v.content } : x)) }
              : d,
          );
        })
        .catch(() => undefined);
    }
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!selectedVersion) {
      editTargetRef.current = null;
      lastSavedTextRef.current = "";
      setEditText("");
      setSaveState("saved");
      return;
    }
    editTargetRef.current = { chapterNo: detail?.chapter_no ?? 0, versionId: selectedVersion.id };
    lastSavedTextRef.current = selectedVersion.content;
    setEditText(selectedVersion.content);
    setSaveState("saved");
    // 切换版本后评价基线随之更换：清除「待重新评价」标记，让当前版本按新评价基线重新计算
    setReviewStale(false);
    reviewBaselineRef.current = selectedVersion.content;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.id]);

  /** 防抖自动保存：停止输入 2s 后自动落盘；无改动不触发。 */
  useEffect(() => {
    if (!editTargetRef.current) return;
    if (editText === lastSavedTextRef.current) {
      // 输入又回到已落盘内容：无未保存改动，撤销「已修改」标记；
      // 若等于已评价基线（改完即恢复原样），现有评价仍有效，同时撤销「重新评价」提示
      setSaveState("saved");
      if (reviewBaselineRef.current != null && editText === reviewBaselineRef.current) setReviewStale(false);
      return;
    }
    setSaveState("dirty");
    // 正文发生改动：已有评价过期，评价栏出现「重新评价」提示（落盘后仍保持，直到重新评价）
    setReviewStale(true);
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 2000);
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editText]);

  /** 卸载兜底：防抖还没到就切页/关面板，把未保存编辑静默落盘。 */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const target = editTargetRef.current;
      if (target && editTextRef.current !== lastSavedTextRef.current) {
        void updateChapterVersion(novelId, target.chapterNo, target.versionId, {
          content: editTextRef.current,
        }).catch(() => undefined);
      }
    };
  }, [novelId]);
  /** 打开「新增章节」弹窗：按当前目录算好目标章号、回填该章已批大纲（若有）。 */
  const openAddModal = useCallback(() => {
    const o = approvedOutlines.find((x) => x.chapter_no === nextNo) ?? null;
    setUseOutline(o != null);
    setForm((f) => ({
      ...f,
      chapter_no: nextNo,
      title: o ? o.title ?? "" : "",
      outline: o ? summarizeOutline(o) : "",
      chapter_function: "",
    }));
    setRegenerateNo(null);
    setShowAddModal(true);
  }, [approvedOutlines, nextNo]);

  /** 打开「重新生成正文」弹窗：复用新增章节弹窗，章节号锁定为当前章，其余字段可改。
   *  后端 _persist_novelist 会基于该 chapter_no 追加一个新草稿版本（需手动定稿）。
   *  版本树：重新生成与新增章节平级，产物为根节点（handleGenerate 不传 parent_version_id）。
   *  重新生成=新增：默认完全空白——不自动沿用已批大纲（避免带入旧章大纲/标题/内容），
   *  不继承旧版本标题；标题留空由 AI 根据新正文重新起。作者可手动打开「沿用已批大纲」开关。 */
  const openRegenerateModal = useCallback(() => {
    if (activeNo == null) return;
    setUseOutline(false);
    setForm((f) => ({
      ...f,
      chapter_no: activeNo,
      title: "",
      outline: "",
      chapter_function: "",
    }));
    setRegenerateNo(activeNo);
    setShowAddModal(true);
  }, [activeNo]);

  // 切章 / 换小说：移除「设定自检」常驻通知（其操作目标是通知当时所在章，切走后不再适用）
  useEffect(() => {
    clearGapNotifIfMismatch(activeNo, novelId);
  }, [activeNo, novelId]);

  /** 弹窗内切换「沿用大纲」开关：开启回填该章已批大纲，关闭清空（= 自由草稿，标题交给 AI）。 */
  function toggleUseOutline(on: boolean) {
    const o = on ? approvedOutlines.find((x) => x.chapter_no === form.chapter_no) ?? null : null;
    setForm((f) => ({
      ...f,
      title: o ? o.title ?? "" : "",
      outline: o ? summarizeOutline(o) : "",
    }));
    setUseOutline(on);
  }

  // 切章请求序号：每次发起 loadDetail/loadApprovedOutlines 递增，await 后比对，
  // 若已被更新的切章请求取代则丢弃本次结果，杜绝"快速切章竞态"（慢的旧响应覆盖新选中章）。
  const loadDetailReqRef = useRef(0);

  /** 拉取全部已批大纲并定位指定章的大纲约束：成功写入 approvedOutlines/approvedOutline；
   *  失败或查无时 approvedOutline 置 null（该章无大纲约束，不阻塞自由写作）。
   *  req 为切章竞态序号：携带它调用时，若已被更新的切章请求取代则丢弃过期结果。 */
  const loadApprovedOutlines = useCallback(
    async (no?: number, req?: number) => {
      try {
        const list = await listOutlines(novelId, "approved");
        // 仅当本次调用携带了请求序号、且已被更新的切章请求取代时，丢弃过期结果
        if (req !== undefined && req !== loadDetailReqRef.current) return;
        const sorted = [...list].sort((a, b) => a.chapter_no - b.chapter_no);
        setApprovedOutlines(sorted);
        const hit =
          no != null ? (sorted.find((o) => o.chapter_no === no) ?? null) : (sorted[sorted.length - 1] ?? null);
        setApprovedOutline(hit);
      } catch {
        if (req !== undefined && req !== loadDetailReqRef.current) return;
        setApprovedOutline(null);
      }
    },
    [novelId],
  );

  /** 拉取章节目录列表：成功写入 chapters；失败走顶部悬浮框提示（不在内联区显示错误）。 */
  const loadChapters = useCallback(async () => {
    try {
      setChapters(await listChapters(novelId));
    } catch (e) {
      // 章节加载失败不内联显示，走顶部悬浮框提示
      message.error((e as Error).message);
    }
  }, [novelId]);

  /** 加载指定章详情 + 大纲约束 + 评价列表。核心是竞态控制：每次调用递增 loadDetailReqRef 序号，
   *  await 后若已被更新的切章请求取代则整段丢弃，杜绝「快速切章」时慢的旧响应覆盖新选中章。
   *  404（正文未生成/加载失败）→ detail 置 null 静默处理，其余错误走顶部提示。
   *  selectVersionId 用于显式指定预览版本（如优化完成后切到新生成的版本），默认回到默认选中规则。 */
  const loadDetail = useCallback(
    async (no: number, selectVersionId?: string | null) => {
      // 请求序号 +1：本次切章的所有后续写入都受它保护，被更新的切章取代时整段丢弃
      const req = ++loadDetailReqRef.current;
      try {
        const d = await getChapter(novelId, no);
        // 竞态守卫：若期间又点了别的章，旧的慢响应直接丢弃，不覆盖新选中章
        if (req !== loadDetailReqRef.current) return;
        setDetail(d);
        // 切章/刷新详情：默认重置版本预览选中，回到默认规则（有已定稿选已定稿、全草稿选最新）；
        // 调用方显式指定要选中的版本（如优化完成后切到新生成版本）则优先选中之
        setSelectedVersionId(
          selectVersionId && d.versions.some((v) => v.id === selectVersionId) ? selectVersionId : null,
        );
      } catch (e) {
        if (req !== loadDetailReqRef.current) return;
        const msg = (e as Error).message;
        // 章节正文尚未生成（如大纲已批准但正文还没生成/上次生成未落库）→ 静默，不报红色错误
        if (msg.includes("404")) {
          setDetail(null);
        } else {
          // 章节详情加载失败不内联显示，走顶部悬浮框提示
          message.error(msg);
        }
      }
      // 大纲约束按当前章号取适用大纲：跟随同一请求序号，慢的旧响应不会改写新章的过期判断
      void loadApprovedOutlines(no, req);
      try {
        const reviews = await listReviews(novelId, no);
        if (req !== loadDetailReqRef.current) return;
        setReviews(reviews);
      } catch {
        if (req !== loadDetailReqRef.current) return;
        setReviews(null);
      }
    },
    [novelId, loadApprovedOutlines],
  );

  useEffect(() => {
    (async () => {
      try {
        const [chs] = await Promise.all([
          listChapters(novelId),
          loadApprovedOutlines(), // 默认：大纲约束 + 最新一章章节大纲
          // 拉取当前生效蓝图，用于章节目录按卷分组
          getActiveBlueprint(novelId)
            .then((bp) => setVolumes(bp?.content?.volumes ?? []))
            .catch(() => setVolumes([])),
        ]);
        setChapters(chs);
        // 进入页面默认选最新一章：有已定稿版本选中定稿正文、无定稿选最新创建的正文
        // （selectedVersionId=null 走默认规则，loadDetail 内部会重置选中态）
        if (chs.length > 0) {
          const latest = chs.reduce((a, b) => (b.chapter_no > a.chapter_no ? b : a));
          setActiveNo(latest.chapter_no);
          void loadDetail(latest.chapter_no);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [loadChapters, loadApprovedOutlines, loadDetail, novelId]);

  // 后台任务（跨页/刷新恢复）由全局 AgentTaskToasts 轮询并提示；完成后派发
  // biling:agent-task-done 事件，这里负责刷新目录/正文，保持"自动落库并刷新"的行为
  useEffect(() => {
    const onDone = (e: Event) => {
      const task = (e as CustomEvent<{ task?: StreamTaskInfo }>).detail?.task;
      void loadChapters();
      if (task?.chapter_no != null) {
        // 任务完成自动切详情时，章节目录高亮/本章操作同步切到该章，避免「详情切了、目录没切」的错位
        setActiveNo(task.chapter_no);
        void loadDetail(task.chapter_no);
      }
    };
    window.addEventListener("biling:agent-task-done", onDone);
    return () => window.removeEventListener("biling:agent-task-done", onDone);
  }, [loadChapters, loadDetail]);

  /** 生成中状态持久化：刷新/切页后重新进入页面时，若后端仍有该小说的 novelist 任务进行中
   *  （agent_tasks），恢复「生成中」状态（弹窗按钮禁用 + 计时 + 「查看生成过程」可用）并轮询到
   *  任务结束，避免刷新后状态丢失、误以为可以再次生成。与大纲页 outliner 恢复同机制；
   *  完成通知与数据刷新由全局 AgentTaskToasts（biling:agent-task-done）负责。 */
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let r: AgentRunningTaskResult;
      try {
        r = await getAgentRunningTask("novelist", novelId);
      } catch {
        return; // 查询失败：不强行恢复
      }
      if (stopped || !r.running || !r.task) return;
      const task = r.task;
      // 恢复生成中状态：用后端累积的流式文字与任务真实开始时间（刷新前已流出的内容不丢）
      setGenStartAt(task.started_at ? new Date(task.started_at).getTime() : Date.now());
      setGenerating(true);
      setGenRun({
        thinking: task.progress?.thinking ?? "",
        output: task.progress?.draft ?? "",
        running: true,
      });
      // 轮询到任务结束（成功/失败均退出）
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let r2: AgentRunningTaskResult;
        try {
          r2 = await getAgentRunningTask("novelist", novelId);
        } catch {
          break; // 查询失败：停止轮询，不再强行维持「生成中」
        }
        if (r2.running && r2.task) {
          const p = r2.task.progress;
          if (p) setGenRun({ thinking: p.thinking, output: p.draft, running: true });
          continue;
        }
        break;
      }
      if (!stopped) {
        setGenerating(false);
        setGenRun((g) => (g ? { ...g, running: false } : g));
        setShowGenRun(false);
        // 与 handleGenerate finally 保持一致：任务完成（成功/失败）后关闭新增章节/重新生成弹窗
        setShowAddModal(false);
        setRegenerateNo(null);
        setGenIsRegenerate(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [novelId]);

  /** 优化中状态持久化：刷新/切页后重新进入页面时，若后端仍有该小说的修订师（reviser）任务进行中
   *  （agent_tasks），恢复「优化中」锁定（按评价优化按钮禁用 + 「查看生成过程」可用）并轮询到
   *  任务结束，避免切页后误以为优化已结束、重复发起优化。与 novelist 恢复同机制；
   *  完成通知与数据刷新由全局 AgentTaskToasts（biling:agent-task-done）负责。 */
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let r: AgentRunningTaskResult;
      try {
        r = await getAgentRunningTask("reviser", novelId);
      } catch {
        return; // 查询失败：不强行恢复
      }
      if (stopped || !r.running || !r.task) return;
      const task = r.task;
      // 恢复优化中状态：用后端累积的流式文字与任务真实开始时间（刷新前已流出的内容不丢）
      setReviseStartAt(task.started_at ? new Date(task.started_at).getTime() : Date.now());
      setRevising(true);
      setReviseRun({ thinking: task.progress?.thinking ?? "", output: task.progress?.draft ?? "", running: true });
      // 轮询到任务结束（成功/失败均退出）
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let r2: AgentRunningTaskResult;
        try {
          r2 = await getAgentRunningTask("reviser", novelId);
        } catch {
          break; // 查询失败：停止轮询，不再强行维持「优化中」
        }
        if (r2.running && r2.task) {
          const p = r2.task.progress;
          if (p) setReviseRun({ thinking: p.thinking, output: p.draft, running: true });
          continue;
        }
        break;
      }
      if (!stopped) {
        setRevising(false);
        setReviseRun((g) => (g ? { ...g, running: false } : g));
        setShowReviseRun(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [novelId]);

  /** 评价中状态持久化：与优化中同理，恢复评价师（critic）进行中的「评价中」锁定并轮询到结束，
   *  避免切页后误以为评价已结束、重复发起评价。 */
  useEffect(() => {
    let stopped = false;
    void (async () => {
      let r: AgentRunningTaskResult;
      try {
        r = await getAgentRunningTask("critic", novelId);
      } catch {
        return; // 查询失败：不强行恢复
      }
      if (stopped || !r.running || !r.task) return;
      const task = r.task;
      setReviewStartAt(task.started_at ? new Date(task.started_at).getTime() : Date.now());
      setReviewing(true);
      setReviewRun({ thinking: task.progress?.thinking ?? "", output: task.progress?.draft ?? "", running: true });
      // 轮询到任务结束（成功/失败均退出）
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let r2: AgentRunningTaskResult;
        try {
          r2 = await getAgentRunningTask("critic", novelId);
        } catch {
          break; // 查询失败：停止轮询，不再强行维持「评价中」
        }
        if (r2.running && r2.task) {
          const p = r2.task.progress;
          if (p) setReviewRun({ thinking: p.thinking, output: p.draft, running: true });
          continue;
        }
        break;
      }
      if (!stopped) {
        setReviewing(false);
        setReviewRun((g) => (g ? { ...g, running: false } : g));
        setShowReviewRun(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [novelId]);

  const activeChapter = chapters.find((c) => c.chapter_no === activeNo) ?? null;
  /** AI 占用中：评价 / 提取进行时锁定面板——目录与版本切换禁点、其他 AI 操作入口全部禁用，本次完成才解除。 */
  const aiBusy = reviewing || extracting;
  /** 只保留属于当前选中版本的评价（原 is_current 过滤 → 绑定选中版本的 chapter_version_id）；
   *  接口已按时间倒序，取第一条即最近一次。 */
  const currentReviews = (reviews ?? []).filter((r) => r.chapter_version_id === selectedVersion?.id);
  const currentReview = currentReviews[0] ?? null;
  /** 全局运行中的后台任务（AgentTaskToasts 每 3 秒轮询 /stream/status 后写入共享状态）。
   *  用于感知"评价/优化是否还在后台跑"：评价栏据此显示加载态、禁用重复手动评价，
   *  避免作者在评价进行中重复点手动评价撞上后端 409「已有生成任务在后台运行」。 */
  const runningTask = useSyncExternalStore(subscribeRunningTask, getRunningTask, () => null);
  /** 是否有评价/优化类后台任务在跑（critic/reviser：手动评价与优化共用同一并发位）。 */
  const reviewTaskRunning = runningTask?.agent === "critic" || runningTask?.agent === "reviser";
  /** 该后台评价任务是否对应当前章节（决定评价栏显示"评价处理中"加载态；对不上章的不打扰当前章）。 */
  const reviewBusyForChapter =
    reviewTaskRunning && (runningTask?.chapter_no == null || runningTask.chapter_no === detail?.chapter_no);
  /** 重新评价提示在评价栏顶部展示：正文改动过（reviewStale）且当前版本已有评价时才出现，
   *  按钮点击直接对当前版本重新评价。 */
  /** 当前选中正文是否「刚生成」（3 分钟内）：提示作者该版本还没有评价、点下方「评价本章」手动评价。
   *  Date.now() 在渲染期读取会触发 react-hooks/purity 告警，改为选中版本变化时用 effect 计算。 */
  const [isRecentlyGenerated, setIsRecentlyGenerated] = useState(false);
  useEffect(() => {
    setIsRecentlyGenerated(
      selectedVersion != null && Date.now() - new Date(selectedVersion.created_at).getTime() < 3 * 60 * 1000,
    );
  }, [selectedVersion]);
  /** 当前预览正文是否为「旧大纲版本」生成的：该章已有批准大纲（approvedOutline）时，
   *  正文版本记录的 outline_id 必须等于它才算"基于激活大纲"，否则只能看、不能评价/修订/提取。
   *  仅当版本绑定了大纲（outline_id 非空）才参与判定：outline_id 为空的自由草稿
   *  （作者主动选择不沿用大纲重写）不受此限，可正常评价/修订/提取。
   *  无批准大纲（自由稿/该章尚未批准）时不限制。 */
  const isStaleForActiveOutline =
    !!selectedVersion &&
    approvedOutline != null &&
    !!selectedVersion.outline_id &&
    String(selectedVersion.outline_id) !== approvedOutline.id;
  /** 选中版本（须已定稿）还没提取过记忆层 → 高亮「提取→记忆层」。
   *  判定依据（任一命中即视为"已提取"，不高亮）：
   *    1. 本会话刚提取过当前章/当前版本（即时反馈）；
   *    2. 持久化的提取记录（story_state.chapter_version_id）== 当前选中版本（刷新后仍准确）。
   *  选中版本尚未加载（null）时不高亮，避免切换章节时闪烁。 */
  const extractedMatch =
    (extractedChapterNo === activeNo && extractedVersionId === selectedVersion?.id) ||
    (activeChapter?.extracted_version_id != null &&
      activeChapter.extracted_version_id === selectedVersion?.id);
  const extractPending =
    !!selectedVersion && selectedIsFinal && !extractedMatch;

  /** 「挨个重写」始终指向最新一次渲染的联动重写逻辑，避免通知里回调闭包过期。 */
  const rerunAffectedRef = useRef<() => void>(() => {});

  /** 受影响章节 → 全局 Notification（右上角、常驻）：状态置位时弹出；切页不隐藏，
   *  只有点 ✕ 或「挨个重写」才关闭（组件卸载不清通知，由模块级持有，回来时状态还原）。
   *  点「挨个重写」（handleRerunAffected 先 setAffectedChapters(null)）或点 ✕ 后通知即关闭。 */
  useEffect(() => {
    syncAffectedNotif(novelId, affectedChapters, () => rerunAffectedRef.current(), () =>
      setAffectedChapters(null),
    );
  }, [novelId, affectedChapters]);

  /** 联动重写中断 → 全局 Notification（右上角、error 类型、不可手动关闭）：
   *  - 状态置位时弹通知（数据更新先移除旧的再重弹），切页不隐藏、回来状态还原（同上，模块级持有）；
   *  - 15s 总展示时长只累计「页面可见时间」：document 不可见/组件卸载时暂停并保留剩余（写 localStorage），
   *    刷新或切页回来继续累计，累计满 15s 才自动关闭（此时才清模块态与本地状态）。
   *  逻辑已封装进 writing/notifications 的 useRewriteFailNotif hook。 */
  useRewriteFailNotif(novelId, rewriteFail, setRewriteFail);

  /** 发起正文生成（新增章节或重新生成正文，靠 regenerateNo 区分）：置生成中 → 合成本次配置 → runAgent SSE。
   *  成功判定：SSE 收到 stored 事件（action=alert 为格式校验未通过仅记录；dry_run 不提示；其余弹成功 toast）；
   *  失败判定：stream_error 事件或 try 抛错（friendlyRunError），均弹错误提示。
   *  收尾统一在 finally：关闭弹窗、刷新目录与详情、弹写后设定自检告警；跨小说守卫下不刷新不提示。 */
  async function handleGenerate(override?: Partial<typeof form>) {
    setGenerating(true);
    // 写后设定自检：本次生成收集到的疑似漏项（SSE setting_warning），完成后弹右上角告警通知
    let collectedGaps: SettingGap[] = [];
    setGenStartAt(Date.now());
    // 记录本次生成模式：新增章节 or 重新生成正文（弹窗关闭后 regenerateNo 会重置，按钮禁用方向靠它判断）
    setGenIsRegenerate(regenerateNo != null);
    // 弹窗保持打开、不自动关闭；生成过程通过「查看 AI 过程」按钮实时查看
    setGenRun({ thinking: "", output: "", running: true });

    // 用传入覆盖（如评价弹窗的「生成正文」）合成本次生成配置；form 保持新增弹窗的表单状态不动
    const f = override ? { ...form, ...override } : form;

    const infoControl: Record<string, string> = {};
    for (const [k, v] of [
      ["reader_knows", f.reader_knows],
      ["protagonist_knows", f.protagonist_knows],
      ["must_hide", f.must_hide],
      ["hint_only", f.hint_only],
    ] as const) {
      if (v.trim()) infoControl[k] = v.trim();
    }

    const tgt = useOutline ? approvedOutlines.find((o) => o.chapter_no === f.chapter_no) ?? null : null;
    const params: Record<string, unknown> = {
      chapter_no: f.chapter_no,
      title: f.title.trim() || undefined,
      outline: f.outline.trim() || undefined,
      outline_id: tgt?.id ?? undefined, // 正文-大纲版本关联：记录用的是哪个已批大纲版本
      chapter_function: f.chapter_function || undefined, // 空 = 交给小说家自动判定
      writing_mode: useOutline ? "outline_guided" : "draft_free",
      goal: f.goal.trim() || undefined,
      // 版本树：新增章节与重新生成正文平级，都是根节点（不传 parent_version_id）；
      // 评价优化（reviser）单独传 parent_version_id=被优化版本，挂为子节点
      // 来源标记：重新生成正文落 source="regenerate"（版本名「再稿」），与新增「初稿」区分
      regenerate: regenerateNo != null ? true : undefined,
      // 重新生成=新增，与新增同权：不传 rewrite，后端 novelist 前置钩子照常弹「本章规划」
      // 方向咨询（作者重新定夺）；仅批量自动重写（handleRerunAffected）传 rewrite+auto_rewrite 跳过
    };
    if (Object.keys(infoControl).length > 0) params.info_control = infoControl;

    try {
      ensureReady();
      await runAgent("novelist", novelId, params, (ev) => {
        // 切到其他小说、或本面板已卸载（切页签）：后续回调不再弹全局提示、不再写入状态
        if (liveNovelRef.current !== novelId || !mountedRef.current) return;
        const d = ev.data as {
          delta?: string;
          status?: string;
          message?: string;
          action?: string;
        };
        if (ev.event === "thinking_delta" && d.delta) {
          setGenRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
        } else if (ev.event === "stream_delta" && d.delta) {
          setGenRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
        } else if (ev.event === "stored") {
          const action = d.action as string | undefined;
          if (action === "alert") {
            showToast(
              `第 ${form.chapter_no} 章生成内容没通过检查（已记录告警）。可点「生成正文」重试。`,
              "error",
            );
          } else if (action !== "dry_run") {
            showToast(
              `第 ${f.chapter_no} 章已生成草稿（新版本），可在版本列表切换预览，满意后手动定稿。`,
              "success",
            );
          }
        } else if (ev.event === "setting_warning") {
          const items = (ev.data as { items?: SettingGap[] }).items ?? [];
          collectedGaps = items.length ? items : [];
        } else if (ev.event === "stream_error") {
          showToast(d.message ?? "AI 生成出错，请稍后重试。", "error");
        }
      });
    } catch (e) {
      if (liveNovelRef.current === novelId && mountedRef.current) showToast((e as Error).message, "error");
    } finally {
      setGenerating(false);
      setGenRun((r) => (r ? { ...r, running: false } : r));
      // 生成完成（成功或失败均视为完成）：关闭新增/重写弹窗与 AI 过程弹窗（对齐大纲页，弹窗不常驻）
      setShowAddModal(false);
      setRegenerateNo(null);
      setShowGenRun(false);
      if (liveNovelRef.current !== novelId) return; // 已切小说：不再用本小说的结果刷新/选中
      setActiveNo(f.chapter_no);
      await loadChapters();
      await loadDetail(f.chapter_no);
      // 写后设定自检命中：弹右上角常驻告警（重新生成 / 忽略）
      if (collectedGaps.length > 0) fireGapNotif(novelId, f.chapter_no, collectedGaps, openRegenerateModal);
    }
  }

  /** 点版本 tab = 仅本地预览选中（不请求、不激活）。
   *  定稿操作统一走顶部「定稿」按钮（handleFinalizeSelected），这里不做任何激活切换。 */
  function handleSelectVersion(versionId: string) {
    if (!detail) return;
    if (!detail.versions.some((v) => v.id === versionId)) return;
    setSelectedVersionId(versionId);
  }

  /** 顶部「定稿」按钮：先落盘草稿区未保存编辑并校验，再弹二次确认（自定义弹窗），确认后执行定稿。
   *  原已定稿版本随之变回草稿（同一时间只能定稿一个版本）。 */
  async function handleFinalizeSelected() {
    // 定稿前先落盘正文草稿区未保存的编辑：定稿会同步章级正文，须基于最新内容；落盘失败则中止
    const savedText = await flushSave();
    if (savedText == null && editTargetRef.current != null) return;
    if (!detail || !selectedVersion || selectedIsFinal) return;
    // 定稿一律需二次确认；签约未过签版本走强制定稿（红字危险弹窗，强制定稿逃生口）
    setConfirmDialog({ kind: selectedVersion.signing_blocked ? "finalize-force" : "finalize", savedText });
  }

  /** 二次确认通过后真正执行定稿。 */
  async function doFinalize() {
    const cfg = confirmDialog;
    if (!cfg) return;
    setConfirmDialog(null);
    if (!detail || !selectedVersion || selectedIsFinal) return;
    const force = cfg.kind === "finalize-force";
    try {
      const updated = await selectVersion(novelId, detail.chapter_no, selectedVersion.id, force);
      setDetail(updated);
      setSelectedVersionId(selectedVersion.id);
      showToast(
        `第 ${updated.chapter_no} 章已定稿（第${selectedVersion.version_no}版 · ${sourceLabel(selectedVersion.source)}），可继续记进 AI 记忆或生成下一章。`,
        "success",
      );
      await loadChapters();
      try {
        setReviews(await listReviews(novelId, updated.chapter_no));
      } catch {
        setReviews(null);
      }
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  }

  /** 复制当前选中版本正文到剪贴板：优先异步 Clipboard API，失败回退 execCommand；无正文/失败均提示。 */
  async function handleCopyContent() {
    if (!selectedVersion?.content) return;
    try {
      await copyText(selectedVersion.content);
      showToast("已复制本章正文", "success");
    } catch {
      showToast("复制失败，请手动选中正文复制。", "error");
    }
  }

  /** 提取当前选中已定稿版本入记忆层：先落盘未保存编辑 → 校验（有章/有版本/非旧大纲/已定稿）→ 二次确认。
   *  成功判定：SSE 的 stored 回执（其 downstream_affected 非空时弹受影响章节通知）；
   *  但 SSE 断流回执可能丢失、后端照常落库，收尾以服务端 extracted_version_id 校准按钮高亮，
   *  避免「已提取仍高亮」误报；确实未落库才提示失败。 */
  async function handleExtract() {
    // 提取前先落盘正文草稿区未保存的编辑：记忆层须基于最新正文内容；落盘失败则中止
    const savedText = await flushSave();
    if (savedText == null && editTargetRef.current != null) return;
    if (!activeChapter) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!selectedVersion) {
      showToast("该章尚未选定版本，无法提取。请先完成生成与选定。", "warning");
      return;
    }
    // 旧大纲版本生成的正文只读：不能提取入记忆层（防止把旧版本的人物状态写进记忆、污染当前大纲语境）
    if (isStaleForActiveOutline) {
      showToast(
        "当前正文基于旧版大纲生成，只能查看，不能记进 AI 记忆。请先基于当前正在用的大纲重新生成一份正文，再定稿并记进 AI 记忆。",
        "warning",
      );
      return;
    }
    // 提取记忆层只对已定稿版本开放：草稿正文还没定稿，先定稿再提取
    if (!selectedIsFinal) {
      showToast("只有已定稿的正文才能记进 AI 记忆。请先在「本章操作」点「定稿」，再点「记进 AI 记忆」。", "warning");
      return;
    }
    // 提取记忆层二次确认：确认后才会真正发起提取（自定义弹窗，规避原生 confirm 在内嵌浏览器的异常）
    setConfirmDialog({ kind: "extract", savedText });
  }

  /** 二次确认通过后真正执行提取。 */
  async function doExtract() {
    const cfg = confirmDialog;
    if (!cfg) return;
    setConfirmDialog(null);
    // 提取前先落盘正文草稿区未保存的编辑：记忆层须基于最新正文内容；落盘失败则中止
    const savedText = await flushSave();
    if (savedText == null && editTargetRef.current != null) return;
    if (!activeChapter) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!selectedVersion) {
      showToast("该章尚未选定版本，无法提取。请先完成生成与选定。", "warning");
      return;
    }
    // 旧大纲版本生成的正文只读：不能提取入记忆层（防止把旧版本的人物状态写进记忆、污染当前大纲语境）
    if (isStaleForActiveOutline) {
      showToast(
        "当前正文基于旧版大纲生成，只能查看，不能记进 AI 记忆。请先基于当前正在用的大纲重新生成一份正文，再定稿并记进 AI 记忆。",
        "warning",
      );
      return;
    }
    if (!selectedIsFinal) {
      showToast("只有已定稿的正文才能记进 AI 记忆。请先在「本章操作」点「定稿」，再点「记进 AI 记忆」。", "warning");
      return;
    }
    // 提取时锁定「当前章节 + 当前选中版本」，用于后续判断正文是否被切换过
    const chapterNo = activeChapter.chapter_no;
    const versionId = selectedVersion.id;
    setExtracting(true);
    let storedSeen = false; // 是否收到 stored 回执：决定完成后从服务端校准还是直接采信回执
    try {
      ensureReady();
      await runAgent(
        "extractor",
        novelId,
        { chapter_no: activeChapter.chapter_no, chapter_text: savedText ?? selectedVersion.content },
        (ev) => {
          // 切到其他小说、或本面板已卸载（切页签）：后续回调不再弹全局提示、不再写入状态
          if (liveNovelRef.current !== novelId || !mountedRef.current) return;
          if (ev.event === "stored") {
            storedSeen = true;
            setExtractedChapterNo(chapterNo);
            setExtractedVersionId(versionId);
            // 本次重提取是否清掉了「被取代过的链条中间环」：若是，列出受影响的下游章节，
            // 提示作者重新提取对齐（根部删/改后，下游递进前提已断裂）。
            const d = ev.data as { downstream_affected?: AffectedChapter[] };
            const affected = Array.isArray(d?.downstream_affected)
              ? d.downstream_affected.filter((a) => a.chapter_no > 0)
              : [];
            setAffectedChapters(affected.length > 0 ? affected : null);
            showToast(`已把第 ${chapterNo} 章记进 AI 的长期记忆`, "success");
          } else if (ev.event === "stream_error") {
            showToast((ev.data as { message?: string }).message ?? "AI 提取出错，请稍后重试。", "error");
          }
        },
      );
    } catch (e) {
      if (liveNovelRef.current === novelId && mountedRef.current) showToast((e as Error).message, "error");
    } finally {
      setExtracting(false);
      // 提取是后台任务：SSE 连接若提前断开，stored 回执可能丢失，但后端照常落库。
      // 无论回执是否收到，都以服务端最新提取记录（extracted_version_id）校准按钮高亮，
      // 避免「已提取但按钮仍高亮」的误报；回执已收到时这里只是顺带刷新目录。
      try {
        const fresh = await listChapters(novelId);
        setChapters(fresh);
        if (liveNovelRef.current === novelId && mountedRef.current && !storedSeen) {
          const refreshed = fresh.find((c) => c.chapter_no === chapterNo);
          if (refreshed?.extracted_version_id != null && refreshed.extracted_version_id === versionId) {
            // 实际已落库（只是回执丢失）：补齐状态，熄灭按钮高亮
            setExtractedChapterNo(chapterNo);
            setExtractedVersionId(versionId);
            showToast(`已把第 ${chapterNo} 章记进 AI 的长期记忆`, "success");
          } else {
            showToast("提取未完成，请稍后重试。", "warning");
          }
        }
      } catch {
        if (liveNovelRef.current === novelId && mountedRef.current && !storedSeen) {
          showToast("提取未完成，请稍后重试。", "warning");
        }
      }
    }
  }

  /** 对当前选中版本发起评价（critic）：先落盘未保存编辑 → 校验（有章/有版本/非旧大纲）→ runAgent SSE 流式展示。
   *  成功判定：流正常结束且未失败（failed 由 stream_error / schema_validate 置位）即提示完成——
   *  不依赖 stored（回执可能因断流丢失但后端照常落库），结束后无条件从服务端校准评价列表；
   *  若评价期间正文未被改动则清除「待重新评价」标记（该评价对应当前内容）。
   *  连接超时兜底 15 分钟：超时中断显示，但后端任务照常跑完落库，刷新可见。 */
  async function handleReview() {
    // 先把正文草稿区未落盘的编辑保存：评价必须基于后端最新正文（不是本地未保存的旧内容）；
    // 落盘失败（确有改动）时中止，避免对旧正文评价。
    const savedText = await flushSave();
    if (savedText == null && editTargetRef.current != null) return;
    if (!detail) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!activeChapter) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!selectedVersion) {
      showToast("该章尚未选定版本，无法评价。请先完成生成与选定。", "warning");
      return;
    }
    // 旧大纲版本生成的正文只读：不能评价（防止拿旧正文的评价结果反向影响当前大纲语境的写作决策）
    if (isStaleForActiveOutline) {
      showToast(
        "当前正文基于旧版大纲生成，只能查看，不能评价。请先基于当前正在用的大纲重新生成一份正文，再对新的正文评价。",
        "warning",
      );
      return;
    }
    setReviewing(true);
    setReviews(null);
    setReviewStartAt(Date.now());
    setReviewRun({ thinking: "", output: "", running: true });
    let failed = false; // 流内失败标记（stream_error / schema 最终校验失败）：失败时不再弹完成提示
    try {
      ensureReady();
      await runAgent(
        "critic",
        novelId,
        {
          chapter_no: detail.chapter_no, // 以详情章节为准（与 selectedVersion/parent_version_id 同源）
          chapter_text: savedText ?? selectedVersion.content,
          chapter_version_id: selectedVersion.id, // 评价绑定当前选中的版本（后端据此落 quality_reviews.chapter_version_id）
          writing_mode: "draft_free",
          outline: approvedOutline ? summarizeOutline(approvedOutline) : undefined,
        },
        (ev) => {
          // 切到其他小说、或本面板已卸载（切页签）：后续回调不再弹全局提示、不再写入状态
          if (liveNovelRef.current !== novelId || !mountedRef.current) {
            return;
          }
          const d = ev.data as { delta?: string; status?: string; message?: string };
          if (ev.event === "thinking_delta" && d.delta) {
            setReviewRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
          } else if (ev.event === "stream_delta" && d.delta) {
            setReviewRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
          } else if (ev.event === "schema_validate" && d.status !== "ok") {
            failed = true;
            showToast("评价结果格式没通过检查，可重试。", "error");
          } else if (ev.event === "stored") {
            // 收到落库回执即先行刷新一次评价列表（早于流结束展示）；流结束后还会无条件校准一次。
            void listReviews(novelId, activeChapter.chapter_no)
              .then(setReviews)
              .catch(() => undefined);
          } else if (ev.event === "stream_error") {
            failed = true;
            showToast((ev.data as { message?: string }).message ?? "AI 评价出错，请稍后重试。", "error");
          }
        },
        undefined,
        false,
        15 * 60 * 1000, // 连接超时兜底：超过 15 分钟中断显示（后端任务照常跑完落库，刷新可见），避免永久"思考中"
      );
      // 评价完成：统一在流结束后弹完成提示（与正文生成成功一致的居中 success）。
      // 回执可能因 SSE 断流丢失但后端照常落库，故按「流正常结束且未失败」提示，不依赖 stored；
      // 无论是否收到 stored，流结束后都无条件从服务端校准一次评价列表：
      //   - 断流丢 stored → 校准兜底；
      //   - 收到了 stored 但事件内的 listReviews 早于落库执行（竞态）→ 此处覆盖，保证与真实数据一致。
      if (liveNovelRef.current === novelId && mountedRef.current && !failed) {
        try {
          setReviews(await listReviews(novelId, activeChapter.chapter_no));
        } catch {
          /* 刷新失败不阻塞完成提示 */
        }
        // 重新评价后：若评价期间作者没有继续改正文，本次评价对应当前内容 →
        // 清除「待重新评价」提示；并刷新详情同步版本的签约标记（signing_blocked「未过签」徽标）。
        if (editTextRef.current === (savedText ?? selectedVersion.content)) {
          setReviewStale(false);
          // 本次评价基于当前正文：把「已评价基线」更新为本次评价的内容，后续改动是否过期以此为准
          reviewBaselineRef.current = editTextRef.current;
        }
        void getChapter(novelId, activeChapter.chapter_no).then(setDetail).catch(() => undefined);
        showToast(`第 ${activeChapter.chapter_no} 章评价完成，报告已展示在「评价与优化」中。`, "success");
      }
    } catch (e) {
      if (liveNovelRef.current === novelId && mountedRef.current) showToast((e as Error).message, "error");
    } finally {
      setReviewing(false);
      setReviewRun((r) => (r ? { ...r, running: false } : r));
      setShowReviewRun(false);
    }
  }

  /** 「评价与优化」已改为右侧常驻内联面板：切换章节时 loadDetail 会按当前章重新拉取评价列表，
   *  因此无需再靠打开弹窗触发刷新，进入面板即是最新（含手动评价完成后的结果）。 */

  /** 根部关系被删/改后，按序串行处理受影响的下游章节：
   *   第 A 章重写正文（按该章已批大纲，无大纲则自由草稿）→ 第 B 章重写 → …
   *  重写用的是 novelist（按大纲写新正文、追加为草稿版本），不自动「提取→记忆层」：作者查看满意后手动定稿再提取。
   *  任一章失败即停止整个流程，弹右上角 error 通知列出未重写的章节，交作者手动补齐（15s 自动关闭）。
   *  进度查看与手动生成完全一致：Message 提示 + 「查看 AI 过程」弹窗 + 目录/详情刷新。 */
  async function handleRerunAffected() {
    if (!affectedChapters || affectedChapters.length === 0) return;
    const target = affectedChapters.map((a) => a.chapter_no); // 按受影响章节逐个处理
    setAffectedChapters(null); // 按钮点击后通知立即关闭
    setRewriteFail(null);
    try {
      ensureReady();
      let failedChapter: number | null = null;
      const doneRewrite: number[] = [];
      for (const no of target) {
        // 处理过程中切到其他小说、或本面板已卸载（切页签）：立即停止，不弹任何本小说的提示
        if (liveNovelRef.current !== novelId || !mountedRef.current) return;
        const o = approvedOutlines.find((x) => x.chapter_no === no) ?? null;
        const ch = chapters.find((c) => c.chapter_no === no) ?? null;
        // ── 1. 重写正文（按当前大纲，不按评价）──
        // 与真人点「生成正文」一致：只更新后台状态，弹窗由作者手动点「查看 AI 过程」查看
        setGenRun({ thinking: "", output: "", running: true });
        try {
          await runAgent(
            "novelist",
            novelId,
            {
              chapter_no: no,
              title: o?.title ?? ch?.title ?? undefined,
              outline: o ? summarizeOutline(o) : undefined,
              outline_id: o?.id ?? undefined, // 正文-大纲版本关联
              writing_mode: o ? "outline_guided" : "draft_free",
              // 自动重写流程方向已定（批量自动化无人工确认环节）：跳过写前「本章规划」咨询，
              // 避免打断批量自动化（手动重新生成不传此标记，照常咨询方向）
              rewrite: true,
              auto_rewrite: true,
            },
            (ev) => {
              // 切到其他小说、或本面板已卸载（切页签）：后续回调不再弹全局提示、不再写入状态
              if (liveNovelRef.current !== novelId || !mountedRef.current) return;
              const d = ev.data as { delta?: string; status?: string; message?: string };
              if (ev.event === "thinking_delta" && d.delta) {
                setGenRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
              } else if (ev.event === "stream_delta" && d.delta) {
                setGenRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
              } else if (ev.event === "stream_error") {
                failedChapter = no;
                showToast((ev.data as { message?: string }).message ?? `第 ${no} 章重写出错`, "error");
              }
            },
          );
        } catch (e) {
          if (liveNovelRef.current !== novelId || !mountedRef.current) return;
          failedChapter = no;
          showToast((e as Error).message, "error");
        } finally {
          setGenRun((r) => (r ? { ...r, running: false } : r));
        }
        if (failedChapter != null) break;
        doneRewrite.push(no);
        // 联动重写只生成草稿：不自动「提取→记忆层」，作者查看正文满意后手动定稿再提取
        // 已切页签（面板卸载）：本页不再弹居中提示，跨页完成由全局右上角通知兜底
        if (liveNovelRef.current === novelId && mountedRef.current) {
          showToast(`第 ${no} 章已重写完成（草稿），可查看并手动定稿`, "success");
        }
      }

      await loadChapters();
      if (liveNovelRef.current !== novelId || !mountedRef.current) return; // 已切小说/已切页签：不再弹本小说的汇总提示
      if (failedChapter != null) {
        // 失败即停止：列出「正文未重写」的章节，交作者手动补齐（含失败后还没轮到处理的章节）
        const remainingRewrite = target.filter((n) => !doneRewrite.includes(n));
        setRewriteFail({ failedChapter, remainingRewrite, remainingExtract: [] });
        const tip = [];
        if (remainingRewrite.length > 0) tip.push(`正文未重写：第 ${remainingRewrite.join("、")} 章`);
        showToast(
          `第 ${failedChapter} 章处理失败，自动连续处理已停止。${tip.length > 0 ? `剩余 ${tip.join("；")}，请手动补齐。` : ""}`,
          "error",
        );
      } else {
        showToast(`已为第 ${target.join("、")} 章生成草稿，可逐个查看并手动定稿`, "success");
      }
    } catch (e) {
      if (liveNovelRef.current === novelId && mountedRef.current) showToast((e as Error).message, "error");
    }
  }

  /** 「挨个重写」始终指向最新一次渲染的联动重写逻辑，避免通知里回调闭包过期。
   *  放在 handleRerunAffected 声明之后，避免 react-hooks/immutability「声明前访问」告警。 */
  useEffect(() => {
    rerunAffectedRef.current = () => handleRerunAffected();
  });

  /** 按评价报告逐条优化本章正文（修订师），修订版直接定稿为新版本。 */
  async function handleRevise(
    review: QualityReview,
    authorInput?: { note?: string; disagreements?: Record<number, string> },
  ) {
    // 先把正文草稿区未落盘的编辑保存：优化基于最新正文；落盘失败（确有改动）时中止
    const savedText = await flushSave();
    if (savedText == null && editTargetRef.current != null) return;
    // 章节归属以当前详情（detail）为准：selectedVersion 与 detail 同源，避免目录高亮与详情错位时
    // 把优化产物挂到目录高亮章（旧 bug：详情已是第4章、目录仍高亮第3章 → 修订版写进第3章版本树）。
    if (!detail) {
      showToast("请先在章节目录选择一章", "warning");
      return;
    }
    if (!selectedVersion) {
      showToast("该章尚未选定版本，无法优化。请先完成生成与选定。", "warning");
      return;
    }
    // 旧大纲版本生成的正文只读：不能修订（与评价同口径，防止把旧正文基于旧大纲再改出一版）
    if (isStaleForActiveOutline) {
      showToast(
        "当前正文基于旧版大纲生成，只能查看，不能优化。请先基于当前正在用的大纲重新生成一份正文，再评价优化。",
        "warning",
      );
      return;
    }
    if (review.chapter_version_id !== selectedVersion.id) {
      showToast(
        `这条评价是对第${review.version_no ?? "?"}版写的，不是当前选中的正文。请先选中对应版本，或对当前正文重新评价。`,
        "warning",
      );
      return;
    }
    setRevising(true);
    // 写后设定自检：本次优化收集到的疑似漏项（SSE setting_warning），完成后弹右上角告警通知
    let collectedGaps: SettingGap[] = [];
    setReviseStartAt(Date.now());
    setReviseRun({ thinking: "", output: "", running: true });
    let failed = false; // 流内失败标记（stream_error / schema 最终校验失败）：失败时不再弹完成提示、不关闭弹窗
    try {
      ensureReady();
      await runAgent(
        "reviser",
        novelId,
        {
          chapter_no: detail.chapter_no, // 以详情章节为准（与 selectedVersion/parent_version_id 同源），
          // 避免目录高亮与详情错位时把优化产物写进错误章节的版本树
          chapter_text: savedText ?? selectedVersion.content,
          writing_mode: useOutline ? "outline_guided" : "draft_free",
          outline: approvedOutline ? summarizeOutline(approvedOutline) : undefined,
          outline_id: approvedOutline?.id ?? undefined, // 正文-大纲版本关联
          chapter_function: form.chapter_function,
          parent_version_id: selectedVersion.id, // 版本树：优化产物挂为被优化版本的子节点（可继续评价→优化递归）
          review: {
            overall_score: review.overall_score,
            rubric: review.rubric,
            issues: review.issues,
            strengths: review.strengths,
            revision_hints: review.revision_hints,
            // 作者批注/异议（作者意图，优先级高于评价师）：随本次优化一次性传入，不落库
            ...(authorInput?.note?.trim() ? { author_note: authorInput.note.trim() } : {}),
            ...(authorInput?.disagreements && Object.keys(authorInput.disagreements).length > 0
              ? { disagreements: authorInput.disagreements }
              : {}),
          },
        },
        (ev) => {
          // 切到其他小说、或本面板已卸载（切页签）：后续回调不再弹全局提示、不再写入状态
          if (liveNovelRef.current !== novelId || !mountedRef.current) {
            return;
          }
          const d = ev.data as { delta?: string; status?: string; message?: string };
          if (ev.event === "thinking_delta" && d.delta) {
            setReviseRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
          } else if (ev.event === "stream_delta" && d.delta) {
            setReviseRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
          } else if (ev.event === "setting_warning") {
            const items = (ev.data as { items?: SettingGap[] }).items ?? [];
            collectedGaps = items.length ? items : [];
          } else if (ev.event === "schema_validate" && d.status !== "ok") {
            failed = true;
            showToast("优化结果格式没通过检查，可重试。", "error");
          } else if (ev.event === "stream_error") {
            failed = true;
            showToast((ev.data as { message?: string }).message ?? "AI 优化出错，请稍后重试。", "error");
          }
        },
        undefined,
        false,
        15 * 60 * 1000, // 连接超时兜底：超过 15 分钟中断显示（后端任务照常跑完落库，刷新可见），避免永久"思考中"
      );
      // 优化完成：统一在流结束后弹完成提示（与正文生成成功一致的居中 success）。
      // 回执可能因 SSE 断流丢失但后端照常落库，故按「流正常结束且未失败」提示，不依赖 stored。
      if (liveNovelRef.current === novelId && mountedRef.current && !failed) {
        showToast(
          `已按评价问题优化第 ${detail.chapter_no} 章，新版本为草稿，请手动定稿。`,
          "success",
        );
      }
    } catch (e) {
      if (liveNovelRef.current === novelId && mountedRef.current) showToast((e as Error).message, "error");
    } finally {
      setRevising(false);
      setReviseRun((r) => (r ? { ...r, running: false } : r));
      setShowReviseRun(false);
      if (liveNovelRef.current !== novelId) return; // 已切小说：不再用本小说的结果刷新/选中
      setActiveNo(detail.chapter_no);
      await loadChapters();
      // 优化成功：加载详情后自动把正文预览切到刚生成的优化版本（新草稿），让作者直接查看优化结果，
      // 而不是停留在被优化版本、或落在"还没有评价"的新版本上被要求评价。
      let selectNewVersionId: string | null = null;
      if (!failed && review) {
        try {
          const fresh = await getChapter(novelId, detail.chapter_no);
          const newVer = [...fresh.versions]
            .filter((v) => v.parent_version_id === review.chapter_version_id && v.id !== review.chapter_version_id)
            .sort((a, b) => (b.version_no ?? 0) - (a.version_no ?? 0))[0];
          selectNewVersionId = newVer?.id ?? null;
        } catch {
          /* 拿不到新版本详情则回退默认选中 */
        }
      }
      await loadDetail(detail.chapter_no, selectNewVersionId);
      // 写后设定自检命中：弹右上角常驻告警（重新生成 / 忽略）
      if (!failed && collectedGaps.length > 0) fireGapNotif(novelId, detail.chapter_no, collectedGaps, openRegenerateModal);
    }
  }

  return (
    <Loading loading={loading}>
      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)] xl:gap-8">
      <ChapterSidebar
        chapters={chapters}
        volumes={volumes}
        chapterSearch={chapterSearch}
        onChapterSearch={setChapterSearch}
        collapsedVols={collapsedVols}
        onToggleVol={(key) => setCollapsedVols((prev) => ({ ...prev, [key]: !prev[key] }))}
        activeNo={activeNo}
        activeChapter={activeChapter}
        activeVersionTitle={selectedVersion?.title}
        aiBusy={aiBusy}
        reviewing={reviewing}
        generating={generating}
        genIsRegenerate={genIsRegenerate}
        showToast={showToast}
        onAdd={openAddModal}
        onSelectChapter={(no) => {
          setActiveNo(no);
          setReviews(null);
          setSelectedVersionId(null);
          setVersionOpen(false);
          void loadDetail(no);
        }}
        onRegenerate={openRegenerateModal}
        selectedVersion={selectedVersion}
        selectedIsFinal={selectedIsFinal}
        extractPending={extractPending}
        isStaleForActiveOutline={isStaleForActiveOutline}
        extracting={extracting}
        onFinalize={() => void handleFinalizeSelected()}
        onExtract={handleExtract}
        onCopy={handleCopyContent}
      />

      {/* 右侧：正文（左，占据主区）+ 评价与优化（右，常驻侧栏）并排，各自独立滚动、互不挤压；
          中窄屏（<xl）回退为上下堆叠，评价栏限高可滚动；xl 起正文与评价左右并排、各自满高独立滚动。正文与评价始终同屏可见，不再用弹窗；评价栏可折叠为窄条让正文全宽阅读。 */}
      <section
        className="flex h-[calc(100dvh-6rem)] min-w-0 flex-col gap-5 overflow-hidden xl:flex-row xl:gap-6"
      >
        {/* ① 当前章节正文（全部版本 + 已定稿正文），显示在界面、不撑破页面高度 */}
        {detail ? (
          <div className="panel flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="panel-head">
              <h3 className="panel-title">
                {/* 点击标题即复制「第 X 章 标题」（含章节号），无需单独按钮 */}
                <span
                  title="点击复制章节标题"
                  className="cursor-pointer select-text"
                  onClick={() => {
                    const t = (selectedVersion?.title ?? detail.title)?.trim();
                    if (!t) {
                      showToast("该章暂无标题，无法复制。", "warning");
                      return;
                    }
                    void copyText(t)
                      .then(() => showToast("已复制章节标题", "success"))
                      .catch(() => showToast("复制失败，请手动选中标题复制。", "error"));
                  }}
                >
                  第 {detail.chapter_no} 章
                  {(selectedVersion?.title ?? detail.title) ? ` ${selectedVersion?.title ?? detail.title}` : ""}
                </span>
                {/* 标题旁版本标识：v{n}，点击展开内联版本树（新增/重新生成=根，评价优化=子级） */}
                <span className="relative inline-flex">
                  <button
                    type="button"
                    onClick={() => setVersionOpen((o) => !o)}
                    className="ml-1 inline-flex cursor-pointer items-baseline rounded-md px-1.5 py-0.5 align-middle transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    title="点击查看这一章的所有版本，可点击切换预览"
                  >
                    {selectedVersion ? (
                      <span className="text-xs font-semibold tabular-nums text-zinc-600 dark:text-zinc-300">
                        第{selectedVersion.version_no}版
                      </span>
                    ) : (
                      <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">第?版</span>
                    )}
                  </button>
                  {versionOpen && detail && (
                    <>
                      {/* 透明点击捕获层：点浮层外部即关闭（非模态，不遮罩正文） */}
                      <div
                        className="fixed inset-0 z-40"
                        aria-hidden
                        onClick={() => setVersionOpen(false)}
                      />
                      <div className="absolute left-0 top-full z-50 mt-2 max-h-[60vh] w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-surface p-2 shadow-book dark:border-zinc-700 dark:bg-zinc-900">
                        <p className="px-2 py-1 text-[11px] leading-5 text-zinc-400">
                          点开是这一章的版本列表，每次生成或重写都会新增一版；按评价优化出的新版会排在被优化那版的下面，可以一直改下去。点节点切换预览。
                        </p>
                        {detail.versions.length > 0 ? (
                          <VersionTree
                            versions={detail.versions}
                            selectedId={selectedVersion?.id ?? null}
                            aiBusy={aiBusy}
                            onSelect={(id) => {
                              handleSelectVersion(id);
                              setVersionOpen(false);
                            }}
                          />
                        ) : (
                          <p className="py-4 text-center text-xs text-zinc-400">这章还没有生成过正文。</p>
                        )}
                      </div>
                    </>
                  )}
                </span>
                <span className="ml-1 text-xs font-normal text-zinc-500">
                  {selectedIsFinal ? "已定稿" : "草稿"}
                </span>
                {/* 当前章节版本字数：跟随正文实时统计（含就地编辑中的内容） */}
                {selectedVersion != null && (
                  <span className="ml-1.5 text-xs font-normal tabular-nums text-zinc-500">
                    · {editText.length} 字
                  </span>
                )}
                {/* 就地编辑保存状态（无改动时不显示；有未保存改动提醒作者，防抖 2s 自动落盘） */}
                {selectedVersion && saveState !== "saved" && (
                  <span className="ml-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    {saveState === "saving" ? "保存中…" : "已修改"}
                  </span>
                )}
                {/* 选中版本签约未过签：红色警示，提示需按评价修正或强制定稿 */}
                {selectedVersion?.signing_blocked && (
                  <span className="ml-1.5 inline-flex items-center gap-1 rounded-md bg-red-600/10 px-1.5 py-0.5 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-600/30 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/30">
                    有红线问题 · 定稿需二次确认
                  </span>
                )}
              </h3>
            </div>
            {selectedVersion ? (
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                spellCheck={false}
                aria-label="本章正文（可直接编辑，停止输入后自动保存）"
                placeholder="直接在正文上修改，停止输入后自动保存；修改后右侧「评价与优化」会出现「重新评价」按钮。"
                className="reading w-full flex-1 min-h-0 resize-none overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-5 outline-none focus:border-primary dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            ) : (
              <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
                本章还没有已选定的正文版本。
              </p>
            )}
          </div>
        ) : activeNo != null ? (
          <div className="panel flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="panel-head">
              <h3 className="panel-title">
                第 {activeNo} 章
              </h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
              第 {activeNo} 章正文还没生成，或暂时没读到，请稍后重试。
            </p>
          </div>
        ) : (
          <div className="panel flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="panel-head">
              <h3 className="panel-title">
                本章正文
              </h3>
            </div>
            <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
              在左侧章节目录选一章查看正文，或点「新增章节」写新的一章。
            </p>
          </div>
        )}

        {/* 评价与优化：右侧常驻侧栏（替代原弹窗），评价师结果与「按评价优化」与正文同屏可见；
            可点标题栏「收起」按钮折叠为窄条，正文即恢复全宽阅读；再点窄条展开。 */}
        {reviewCollapsed ? (
          <div className="panel flex max-h-[45vh] min-h-0 flex-row items-center justify-center gap-2 py-2 xl:max-h-none xl:w-12 xl:flex-col xl:shrink-0 xl:justify-start xl:py-3">
            <button
              type="button"
              onClick={() => setReviewCollapsed(false)}
              title="展开评价与优化"
              aria-label="展开评价与优化"
              className="btn btn-ghost h-8 w-8 shrink-0 p-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M9 6l6 6-6 6" /></svg>
            </button>
            <span className="text-xs tracking-widest text-zinc-500 dark:text-zinc-400 xl:[writing-mode:vertical-rl]">评价与优化</span>
          </div>
        ) : (
          <div
            className="panel flex max-h-[45vh] min-h-0 flex-col xl:max-h-none xl:w-[var(--review-w)] xl:shrink-0"
            style={{ "--review-w": `${Math.round(reviewWidth)}px` } as CSSProperties}
          >
          <div className="panel-head shrink-0">
            <h3 className="panel-title">评价与优化</h3>
            <div className="flex items-center gap-2">
              {/* 宽度三档（仅并排时有效）：窄/中/宽一键切换 */}
              <div className="hidden items-center gap-0.5 rounded border border-zinc-200 p-0.5 xl:flex dark:border-zinc-700">
                {REVIEW_W_PRESETS.map(([label, w]) => {
                  const on = Math.round(reviewWidth) === w;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setReviewWidth(w)}
                      aria-pressed={on}
                      title={`评价栏宽度设为 ${w}`}
                      className={`rounded px-1.5 py-0.5 text-[11px] leading-none transition-colors ${
                        on
                          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => setReviewCollapsed(true)}
                title="收起，正文全宽阅读"
                aria-label="收起评价与优化"
                className="btn btn-ghost h-7 w-7 shrink-0 p-0"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M15 6l-6 6 6 6" /></svg>
              </button>
            </div>
          </div>
          <div className="@container min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {detail ? (
              <>
                {reviewStale && currentReview != null && (
                  <div className="mb-2.5 flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-500/10">
                    <p className="min-w-0 flex-1 text-xs leading-5 text-amber-800 dark:text-amber-200">
                      正文已修改，现有评价基于修改前的内容，已不对应当前版本。点击「重新评价」对本版本重新评价。
                    </p>
                    <button
                      type="button"
                      onClick={handleReview}
                      disabled={reviewing || reviewTaskRunning || !selectedVersion}
                      className="btn btn-primary shrink-0 px-3 py-1 text-xs font-medium"
                    >
                      {reviewing ? "评价中…" : reviewTaskRunning ? "已有评价任务进行中…" : "重新评价"}
                    </button>
                  </div>
                )}
                {currentReview ? (
                <ReviewCard
                  review={currentReview}
                  onRevise={handleRevise}
                  revising={revising}
                  activeVersionId={selectedVersion?.id ?? null}
                  viewButton={
                    revising ? (
                      <button
                        type="button"
                        onClick={() => setShowReviseRun(true)}
                        className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                      >
                        查看生成过程
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-300 p-5 text-center dark:border-zinc-700">
                  {!reviewing && reviewBusyForChapter ? (
                    /* 评价任务进行中：显示加载态——手动评价/优化在后台异步跑（约几分钟），
                       此时不打扰、也不让作者重复点手动评价（会撞 409）。
                       任务完成由 agent-task-toasts 派发事件触发本面板刷新，评价会自动显示。 */
                    <div className="flex flex-col items-center gap-2.5 py-1">
                      <svg aria-hidden viewBox="0 0 24 24" fill="none" className="h-6 w-6 animate-spin text-seal">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                      <p className="text-xs leading-6 text-zinc-500 dark:text-zinc-400">
                        正在评价第 {detail.chapter_no} 章（正在后台处理，约几分钟，完成后会自动显示）…
                      </p>
                      <p className="text-xs leading-5 text-zinc-400 dark:text-zinc-500">
                        评价完成后会自动显示在这里，无需重复操作
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs leading-6 text-zinc-500 dark:text-zinc-400">
                        {selectedVersion ? (
                          <>
                            当前选中的第{selectedVersion.version_no}版正文还没有评价。
                            {reviewTaskRunning ? (
                              <>当前已有评价任务在后台运行，请等待其完成后再手动评价。</>
                            ) : isRecentlyGenerated ? (
                              <>
                                该版本刚生成，还没有评价。点下方「评价本章」手动评价。
                              </>
                            ) : (
                              <>点下方「评价本章」，AI 会对照全书设定、已埋的伏笔逐项打分。</>
                            )}
                          </>
                        ) : (
                          "该章还没有选定版本的正文，先在界面生成并选定一版，再回来评价。"
                        )}
                      </p>
                      <div className="mt-2.5 flex items-center justify-center gap-2">
                        <button
                          onClick={handleReview}
                          disabled={reviewing || reviewTaskRunning || !selectedVersion}
                          className="btn btn-primary px-3 py-1.5 text-xs font-medium"
                        >
                          {reviewing ? "评价中…" : reviewTaskRunning ? "已有评价任务进行中…" : "评价本章"}
                        </button>
                        {reviewing && (
                          <button
                            type="button"
                            onClick={() => setShowReviewRun(true)}
                            className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                          >
                            查看生成过程
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
              }
              </>
            ) : (
              <p className="text-center text-xs text-zinc-400">请先在左侧章节目录选择一章。</p>
            )}
          </div>
        </div>
        )}

        {/* 联动重写中断：已迁移为右上角全局 error Notification（writing-panel 顶部 rewriteFail 同步 effect 管理） */}
      </section>

      {/* ── 新增章节抽屉：右侧滑入的内联面板（替代居中弹窗，不遮挡正文，填写时可对照左侧正文） ── */}
      {showAddModal && (
        <>
          <div
            className="fixed inset-0 z-[90] bg-black/30"
            aria-hidden
            onClick={() => {
              setShowAddModal(false);
              setRegenerateNo(null);
            }}
          />
          <aside
            role="dialog"
            aria-modal="true"
            className="fixed right-0 top-0 z-[95] flex h-[100dvh] w-[440px] max-w-[92vw] flex-col border-l border-zinc-200 bg-surface shadow-book dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-700">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {regenerateNo != null ? "重新生成章节正文" : "新增章节"}
                </h3>
                <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  {regenerateNo != null
                    ? `将重新写第 ${form.chapter_no} 章（会另存新的一版，原稿保留），标题 / 大纲目标 / 本章节奏定位等均可修改。`
                    : `将追加为第 ${nextNo} 章（目录最新一章的下一章）。写正文前会先让你确认这一章的安排；生成后是草稿，确认满意后定稿。`}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setShowAddModal(false);
                  setRegenerateNo(null);
                }}
                className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {/* 沿用大纲开关：仅该章有已批大纲时出现（无已批大纲时不显示任何规划提示） */}
          {targetOutline && (
            <>
              <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900">
                <span className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300">
                  沿用该章已确认的大纲
                  <InfoTip portal>
                    <p className="font-medium text-zinc-700 dark:text-zinc-200">第 {form.chapter_no} 章有已确认的大纲</p>
                    开启：自动填到下方「本章目标」，写正文前仍会弹出本章规划供你确认沿用或另选
                    <br />关闭：不用大纲，让 AI 自由发挥，标题由 AI 根据内容生成
                  </InfoTip>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useOutline}
                  onClick={() => toggleUseOutline(!useOutline)}
                  disabled={generating}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    useOutline ? "bg-seal" : "bg-zinc-300 dark:bg-zinc-600"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      useOutline ? "translate-x-4" : ""
                    }`}
                  />
                </button>
              </div>
              {useOutline ? (
                <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-xs leading-5 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                  将基于已确认的大纲：第 {targetOutline.chapter_no} 章
                  {targetOutline.title ? `《${targetOutline.title}》` : ""}（大纲内容已自动填入下方「本章目标」，
                  写正文前仍会弹出本章规划，你可确认沿用或另选一套）。
                </div>
              ) : (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-5 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400">
                  已关闭大纲沿用：本章不用大纲，让 AI 自由发挥，标题由 AI 根据内容生成
                  （写正文前仍会弹出本章规划供你确认）。
                </div>
              )}
            </>
          )}

          {/* 自由草稿（未沿用大纲）：章节名称可手动填（带标签，避免高度错位） */}
          {!useOutline && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">章节名称</span>
              <input
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                placeholder="章节标题（留空则 AI 自动生成）"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                disabled={generating}
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">本章节奏定位</span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.chapter_function}
              onChange={(e) => setForm({ ...form, chapter_function: e.target.value })}
              disabled={generating}
            >
              <option value="">本章节奏定位：自动判定</option>
              {FUNCTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  本章节奏定位：{l}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">本章目标 / 写作要求</span>
            <AutoTextarea
              value={form.outline}
              onChange={(v) => setForm({ ...form, outline: v })}
              maxHeight={200}
              disabled={generating}
              placeholder={
                targetOutline && useOutline
                  ? "已自动来自该章已确认的大纲（可微调）。写正文前仍会弹出本章规划供确认"
                  : "本章目标/写作要求（可选）。写正文前会弹出本章规划供确认，不填则按蓝图自动规划"
              }
              className="resize-none rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>

          {/* 信息控制：高级可选项，点开独立弹窗填写/清空 */}
          <div className="flex items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <span className="text-xs text-zinc-500">
              谁知道了什么（可选）
              <InfoTip portal>
                <p className="font-medium text-zinc-700 dark:text-zinc-200">控制「谁知道了什么」</p>
                防止 AI 提前剧透或逻辑穿帮；全部留空则让 AI 自己把握。
                <span className="mt-1.5 block text-zinc-400">
                  读者已知 / 主角已知 / 必须向读者隐瞒 / 只能点到为止（伏笔暗示）
                </span>
              </InfoTip>
            </span>
            <button
              type="button"
              onClick={openInfoModal}
              disabled={generating}
              className="btn btn-ghost px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              {infoFilledCount > 0 ? `已填 ${infoFilledCount} 项 · 编辑` : "填写"}
            </button>
          </div>
        </div>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-700">
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false);
                  setRegenerateNo(null);
                }}
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
                  onClick={() => void handleGenerate()}
                  disabled={generating || !canAdd}
                  className="btn btn-primary px-4 py-1.5 disabled:opacity-50"
                >
                  {generating ? "生成中…" : "生成正文"}
                </button>
                {/* 点击生成后出现：打开生成过程弹窗（与大纲新增弹窗一致，仅生成中显示） */}
                {generating && (
                  <button
                    type="button"
                    onClick={() => setShowGenRun(true)}
                    className="btn btn-ghost px-3 py-1.5 text-xs font-medium"
                  >
                    查看生成过程
                  </button>
                )}
              </div>
            </div>
          </aside>
        </>
      )}

      {/* ── 信息控制弹窗（本地 draft：取消丢弃 / 清空只清本地 / 完成才提交） ── */}
      <Modal
        open={showInfoModal}
        title="谁知道了什么（可选）"
        subtitle="控制本章「谁知道了什么」，防止 AI 提前剧透或逻辑穿帮。"
        onClose={() => setShowInfoModal(false)}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowInfoModal(false)}
              className="btn btn-ghost px-4 py-1.5"
            >
              取消
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setInfoDraft({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" })
                }
                className="btn btn-ghost px-4 py-1.5"
              >
                清空
              </button>
              <button
                type="button"
                onClick={() => {
                  setForm((f) => ({ ...f, ...infoDraft }));
                  setShowInfoModal(false);
                }}
                className="btn btn-primary px-4 py-1.5"
              >
                完成
              </button>
            </div>
          </div>
        }
      >
        <div className="grid gap-3">
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="读者已知：…"
            value={infoDraft.reader_knows}
            onChange={(e) => setInfoDraft({ ...infoDraft, reader_knows: e.target.value })}
          />
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="主角已知：…"
            value={infoDraft.protagonist_knows}
            onChange={(e) => setInfoDraft({ ...infoDraft, protagonist_knows: e.target.value })}
          />
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="必须向读者隐瞒：…"
            value={infoDraft.must_hide}
            onChange={(e) => setInfoDraft({ ...infoDraft, must_hide: e.target.value })}
          />
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="只能点到为止（伏笔暗示）：…"
            value={infoDraft.hint_only}
            onChange={(e) => setInfoDraft({ ...infoDraft, hint_only: e.target.value })}
          />
          <p className="text-xs leading-relaxed text-zinc-500">
            全部留空则让 AI 自己把握。点「完成」才保存；点「清空」只清当前输入、不立即生效；点「取消」则放弃本次改动。
          </p>
        </div>
      </Modal>

      {/* 评价与优化、版本树已改为右侧常驻内联面板，不再使用弹窗 */}

      {/* ── AI 处理过程弹窗：生成正文 / 评价 / 优化统一复用蓝图、大纲页的公共组件（DeepSeek 同款交互） ── */}
      <AgentStreamModal
        open={showGenRun}
        onClose={() => setShowGenRun(false)}
        title={`AI 写作 · 第 ${regenerateNo ?? form.chapter_no} 章 · ${regenerateNo != null ? "重新生成正文" : "新增正文"}`}
        running={genRun?.running ?? false}
        draftText={genRun?.output ?? ""}
        thinkingText={genRun?.thinking ?? ""}
        elapsed={genElapsed}
        novelId={novelId}
        emptyRunningText={
          "AI 写作正在构思正文（AI 思考期约 1-3 分钟，此阶段通常没有正文输出），\n正文开始生成后会在这里实时滚动显示…"
        }
        emptyDoneText="生成完成，正文已保存为新的一版，请手动确认定稿。"
      />
      <AgentStreamModal
        open={showReviewRun}
        onClose={() => setShowReviewRun(false)}
        title={`AI 评审 · 第 ${activeNo ?? "?"} 章`}
        running={reviewRun?.running ?? false}
        draftText={reviewRun?.output ?? ""}
        thinkingText={reviewRun?.thinking ?? ""}
        elapsed={reviewElapsed}
        novelId={novelId}
        emptyRunningText={
          "AI 正在对照全书设定和已埋伏笔逐项评审（思考期约1-3分钟，通常没字，属正常），\n评价内容开始输出后会在这里实时滚动显示…"
        }
        emptyDoneText="评价完成，结果已展示在下方评价卡片。"
      />
      <AgentStreamModal
        open={showReviseRun}
        onClose={() => setShowReviseRun(false)}
        title={`AI 优化 · 第 ${activeNo ?? "?"} 章`}
        running={reviseRun?.running ?? false}
        draftText={reviseRun?.output ?? ""}
        thinkingText={reviseRun?.thinking ?? ""}
        elapsed={reviseElapsed}
        novelId={novelId}
        emptyRunningText={
          "AI 正在逐条对照评价问题优化正文（AI 思考期约 1-3 分钟），\n优化后的正文开始输出后会在这里实时滚动显示…"
        }
        emptyDoneText="优化完成，已生成新草稿版本，请手动定稿。"
      />

      {/* ── 二次确认弹窗（定稿 / 提取记忆层）：页面内自定义弹窗替代 window.confirm ── */}
      <ConfirmDialog
        open={confirmDialog != null}
        title={
          confirmDialog?.kind === "finalize-force"
            ? "强制定稿（有红线或抄袭风险）"
            : confirmDialog?.kind === "finalize"
              ? "确认定稿"
              : "确认提取到记忆层"
        }
        message={
          confirmDialog?.kind === "finalize-force"
            ? "这一版有红线或抄袭风险，不能直接定稿。\n\n强制定稿会把有问题的正文作为本章正式正文，请先按 AI 的修改建议改一下，或确认风险后继续。\n\n仍要强制定稿吗？"
            : confirmDialog?.kind === "finalize"
              ? `确认把第${selectedVersion?.version_no ?? "?"}版（${sourceLabel(selectedVersion?.source ?? "")}）作为本章正式正文？\n\n之前定稿的那版会自动变回草稿（一章只能有一个正式版）。`
              : "确认提取本章到记忆层？\n\n会把本章摘要、角色当前状态、新埋伏笔等写入记忆层，下一章生成时小说家会自动读到。\n\n每写完一章记得提取一次，否则下一章可能「忘了」刚才发生了什么。"
        }
        confirmText={confirmDialog?.kind === "finalize-force" ? "仍要强制定稿" : "确认"}
        tone={confirmDialog?.kind === "finalize-force" ? "danger" : "primary"}
        onConfirm={() => {
          if (confirmDialog?.kind === "extract") void doExtract();
          else void doFinalize();
        }}
        onCancel={() => setConfirmDialog(null)}
      />
      </div>
    </Loading>
  );
}
