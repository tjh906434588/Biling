/**
 * @file writing-panel.tsx
 * 写作页主面板：状态编排 + 组合各子块。承担全局状态与 AI 流程编排（章节/版本/正文编辑、
 * AI 生成/评价/优化/提取/联动重写），渲染与流程按职责拆到 writing/ 目录：
 * - notifications.ts：模块级全局通知机制（受影响章节 / 联动重写中断 / 设定自检），跨页存活；
 * - chapter-tree.tsx：左侧章节目录栏（卷分组/搜索/折叠 + 本章操作）；
 * - version-tree.tsx：版本树浮层（多级递归）；
 * - review-card.tsx：评价师结果卡片；
 * - auto-textarea.tsx：自动增高文本框；
 * - panel-utils.ts：模块级纯函数/类型/常量（表单、AI 运行态、大纲摘要、提取校验）；
 * - chapter-content.tsx：右侧当前章正文面板（标题/版本树浮层/就地编辑/空态）；
 * - review-sidebar.tsx：评价与优化常驻侧栏（折叠/宽度预设/评价卡片/空态）；
 * - add-chapter-drawer.tsx：新增章节/重新生成抽屉；
 * - info-modal.tsx：信息控制（谁知道了什么）弹窗；
 * - run-modals.tsx：三个 AI 过程弹窗 + 定稿/提取二次确认弹窗；
 * - use-chapter-editor.ts：正文就地编辑机制（镜像 ref + 防抖落盘 + 切版本/卸载兜底）；
 * - use-resume-agent-task.ts：刷新/切页后恢复进行中 AI 任务（三段重复轮询收敛）；
 * - use-ai-flows.ts：AI 流程（生成/评价/优化/提取/定稿/联动重写），经 FlowCtx 传入共享状态。
 * 核心机制（保持不变）：
 * - AI 流程（生成/评价/优化/提取）走 runAgent SSE，任务跨页/刷新由全局 AgentTaskToasts 轮询恢复；
 * - 正文编辑「镜像 ref + 防抖 2s 自动落盘 + 切版本/卸载兜底落盘」，切章用请求序号防竞态覆盖；
 * - liveNovelRef + mountedRef 跨小说/卸载守卫 + 模块级通知状态（writing/notifications），
 *   保证切页不误弹、跨页通知不丢。
 */
"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getActiveBlueprint,
  getChapter,
  getChapterInfoControl,
  listChapters,
  listOutlines,
  listReviews,
  type ChapterDetail,
  type ChapterListItem,
  type InfoControl,
  type Outline,
  type QualityReview,
  type StreamTaskInfo,
} from "@/lib/api";
import { useElapsed } from "@/lib/use-elapsed";
import Loading from "@/components/loading";
import { message } from "@/components/message";
import { useAiStatus } from "@/lib/ai-status";
import {
  REVIEW_W_DEFAULT,
  REVIEW_W_KEY,
  REVIEW_W_MAX,
  REVIEW_W_MIN,
  type VolumeInfo,
} from "@/constants";
import { copyText } from "@/utils/clipboard";
import { getRunningTask, subscribeRunningTask } from "@/lib/task-status";
import { ChapterSidebar } from "./components/chapter-tree";
import {
  clearGapNotifIfMismatch,
  getInitialAffectedChapters,
  getInitialRewriteFail,
  syncAffectedNotif,
  useRewriteFailNotif,
  type AffectedChapter,
  type RewriteFailData,
} from "./components/notifications";
import { AddChapterDrawer } from "./components/add-chapter-drawer";
import { ChapterContent } from "./components/chapter-content";
import { InfoModal } from "./components/info-modal";
import {
  summarizeOutline,
  type AiRunState,
  type ConfirmDialogState,
  type GenForm,
  type InfoDraft,
  type ShowToast,
  EMPTY_FORM,
} from "./components/panel-utils";
import { ReviewSidebar } from "./components/review-sidebar";
import { RunModals } from "./components/run-modals";
import { useChapterEditor } from "./components/use-chapter-editor";
import { useResumeAgentTask } from "./components/use-resume-agent-task";
import {
  handleGenerate,
  handleFinalizeSelected,
  doFinalize,
  handleExtract,
  doExtract,
  handleReview,
  handleRerunAffected,
  handleRevise,
  type FlowCtx,
} from "./components/use-ai-flows";
export { hideWorkspaceNotifs, showWorkspaceNotifs } from "./components/notifications";

interface Props {
  novelId: string;
}

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
  const showToast: ShowToast = (msg, level = "success") => {
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

  // ── 派生值（编辑器 hook 与 AI 流程共享） ──
  /**
   * 目录里「最新一章」的下一章号：新增永远只追加最新的一章，不允许跳号或回填旧章。
   * 大纲+章节合并后不再要求该章有已批大纲：写正文前由「本章规划」弹窗确认，确认后直接写作。
   */
  const maxChapterNo = chapters.reduce((m, c) => Math.max(m, c.chapter_no), 0);
  const nextNo = maxChapterNo + 1;
  /** 当前预览选中的正文版本：决定正文区显示、复制/提取/评价的对象、顶部「定稿」按钮目标。
   *  默认规则——有已定稿版本选已定稿版；全部未定稿选最新版；点版本 tab 可本地切换预览。 */
  const selectedVersion =
    (selectedVersionId != null
      ? (detail?.versions.find((v) => v.id === selectedVersionId) ?? null)
      : null) ??
    (detail?.versions.find((v) => v.is_active) ?? detail?.versions[detail.versions.length - 1] ?? null);
  /** 选中版本是否为已定稿（激活）版本：决定「定稿」/「提取」按钮是否可用。 */
  const selectedIsFinal = selectedVersion?.is_active ?? false;
  const activeChapter = chapters.find((c) => c.chapter_no === activeNo) ?? null;

  // ── 正文就地编辑机制（镜像 ref + 防抖落盘 + 切版本/卸载兜底），详见 use-chapter-editor ──
  const {
    editText,
    setEditText,
    saveState,
    flushSave,
    reviewStale,
    setReviewStale,
    editTextRef,
    editTargetRef,
    reviewBaselineRef,
  } = useChapterEditor({
    novelId,
    selectedVersion,
    detailChapterNo: detail?.chapter_no,
    setDetail,
    showToast,
  });

  // 弹窗开关：新增章节 / 信息控制 仍用弹窗；评价与优化、版本树已改为右侧常驻内联面板（见下方）
  const [showAddModal, setShowAddModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  /** 二次确认弹窗（定稿 / 提取记忆层）：用页面内自定义弹窗替代 window.confirm，
   *  规避 IDE 内嵌浏览器对原生 confirm 对话框的处理异常（原生弹窗挂起会导致页面卡死/跳转报错）。 */
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
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

  /** 信息控制弹窗：本地 draft，点「完成」才提交，点「取消」丢弃。
   *  「谁知道了什么」按章设立（chapters.info_control）：生成/重写本章时填写，不可事后单独编辑；
   *  生效信息由后端按「全局默认 + 已定稿章节链 + 本章」合并（弹窗里 effective 只读展示）。 */
  const [infoDraft, setInfoDraft] = useState<InfoDraft>({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
  /** 当前目标章已填的信息控制（生成时提交为本章信息控制；打开新增/重写弹窗时加载该章已有值） */
  const [infoControl, setInfoControl] = useState<InfoControl>({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
  /** 当前章生效的合并结果（只读展示；打开弹窗时拉取） */
  const [infoEffective, setInfoEffective] = useState<InfoControl>({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
  /** 按目标章拉取信息控制：填入草稿 + 生效合并展示 */
  const loadChapterInfo = useCallback(async (chapterNo: number) => {
    try {
      const { chapter, effective } = await getChapterInfoControl(novelId, chapterNo);
      setInfoControl({ ...chapter });
      setInfoEffective({ ...effective });
      return chapter;
    } catch {
      setInfoControl({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
      setInfoEffective({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
      return null;
    }
  }, [novelId]);
  /** 打开信息控制弹窗：按当前目标章拉取（取消丢弃不落库） */
  const openInfoModal = useCallback(async () => {
    const chapter = await loadChapterInfo(form.chapter_no);
    setInfoDraft({ ...(chapter ?? { reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" }) });
    setShowInfoModal(true);
  }, [form.chapter_no, loadChapterInfo]);
  /** 查看当前章已填的信息控制（只读弹窗）：生成后没有填写入口，从「本章操作」进入查看 */
  const [infoView, setInfoView] = useState<InfoDraft | null>(null);
  const [infoViewEffective, setInfoViewEffective] = useState<InfoControl>({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
  const openInfoView = useCallback(async () => {
    if (activeNo == null) return;
    try {
      const { chapter, effective } = await getChapterInfoControl(novelId, activeNo);
      setInfoView({ ...chapter });
      setInfoViewEffective({ ...effective });
    } catch {
      setInfoView({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
      setInfoViewEffective({ reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" });
    }
  }, [novelId, activeNo]);

  /** AI 服务状态检查：各 AI 操作发起前确认模型已配置可用，未配置则抛错拦截（避免发起注定失败的空请求）。 */
  const { ensureReady } = useAiStatus();

  /** 目标章已批大纲：弹窗「沿用该章已批大纲」开关与回填的依据（仅该章有已批大纲时显示开关）。 */
  const targetOutline = approvedOutlines.find((o) => o.chapter_no === form.chapter_no) ?? null;
  /** 信息控制已填项数：弹窗入口按钮据此显示「已填 N 项 · 编辑」。 */
  const infoFilledCount = [infoControl.reader_knows, infoControl.protagonist_knows, infoControl.must_hide, infoControl.hint_only].filter(
    (v) => v.trim(),
  ).length;

  // ── 数据加载：目录 / 大纲约束 / 详情 / 评价，切章用请求序号防竞态覆盖 ──
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

  // ── 刷新/切页后恢复进行中 AI 任务（novelist/reviser/critic，通用轮询见 use-resume-agent-task） ──
  useResumeAgentTask({
    agent: "novelist",
    novelId,
    onStart: (i) => {
      const chapterNo = Number(i.params.chapter_no);
      const isRegenerate = i.params.regenerate === true;
      if (Number.isFinite(chapterNo)) {
        setForm((f) => ({
          ...f,
          chapter_no: chapterNo,
          title: typeof i.params.title === "string" ? i.params.title : f.title,
          outline: typeof i.params.outline === "string" ? i.params.outline : f.outline,
          chapter_function:
            typeof i.params.chapter_function === "string" ? i.params.chapter_function : f.chapter_function,
          goal: typeof i.params.goal === "string" ? i.params.goal : f.goal,
        }));
        setRegenerateNo(isRegenerate ? chapterNo : null);
        void loadDetail(chapterNo);
      }
      setShowAddModal(true);
      setGenStartAt(i.startedAt);
      setGenIsRegenerate(isRegenerate);
      setGenerating(true);
      setGenRun({ thinking: i.thinking, output: i.output, running: true });
    },
    onProgress: (i) => setGenRun({ thinking: i.thinking, output: i.output, running: true }),
    onEnd: () => {
      setGenerating(false);
      setGenRun((g) => (g ? { ...g, running: false } : g));
      setShowGenRun(false);
      // 与 handleGenerate finally 保持一致：任务完成（成功/失败）后关闭新增章节/重新生成弹窗
      setShowAddModal(false);
      setRegenerateNo(null);
      setGenIsRegenerate(false);
    },
  });
  useResumeAgentTask({
    agent: "reviser",
    novelId,
    onStart: (i) => {
      const chapterNo = Number(i.params.chapter_no);
      if (Number.isFinite(chapterNo)) setActiveNo(chapterNo);
      setReviseStartAt(i.startedAt);
      setRevising(true);
      setReviseRun({ thinking: i.thinking, output: i.output, running: true });
    },
    onProgress: (i) => setReviseRun({ thinking: i.thinking, output: i.output, running: true }),
    onEnd: () => {
      setRevising(false);
      setReviseRun((g) => (g ? { ...g, running: false } : g));
      setShowReviseRun(false);
    },
  });
  useResumeAgentTask({
    agent: "critic",
    novelId,
    onStart: (i) => {
      const chapterNo = Number(i.params.chapter_no);
      if (Number.isFinite(chapterNo)) setActiveNo(chapterNo);
      setReviewStartAt(i.startedAt);
      setReviewing(true);
      setReviewRun({ thinking: i.thinking, output: i.output, running: true });
    },
    onProgress: (i) => setReviewRun({ thinking: i.thinking, output: i.output, running: true }),
    onEnd: () => {
      setReviewing(false);
      setReviewRun((g) => (g ? { ...g, running: false } : g));
      setShowReviewRun(false);
    },
  });

  // ── 派生状态：AI 占用锁定 / 评价对照 / 版本高亮 ──
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

  // ── 全局通知联动（受影响章节 / 联动重写中断 / 设定自检） ──
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

  // 切章 / 换小说：移除「设定自检」常驻通知（其操作目标是通知当时所在章，切走后不再适用）
  useEffect(() => {
    clearGapNotifIfMismatch(activeNo, novelId);
  }, [activeNo, novelId]);

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
    // 加载下一章已填的信息控制（新增弹窗入口按钮显示「已填 N 项」，生成时提交）
    void loadChapterInfo(nextNo);
  }, [approvedOutlines, nextNo, loadChapterInfo]);

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
    // 加载该章已填的信息控制（重写弹窗回显「已填 N 项」并可在生成时覆盖）
    void loadChapterInfo(activeNo);
  }, [activeNo, loadChapterInfo]);

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

  /** 点版本 tab = 仅本地预览选中（不请求、不激活）。
   *  定稿操作统一走顶部「定稿」按钮（handleFinalizeSelected），这里不做任何激活切换。 */
  function handleSelectVersion(versionId: string) {
    if (!detail) return;
    if (!detail.versions.some((v) => v.id === versionId)) return;
    setSelectedVersionId(versionId);
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

  // ── AI 流程：共享状态经 FlowCtx 传给 use-ai-flows（行为与拆分前逐字一致） ──
  const flowCtx: FlowCtx = {
    novelId,
    liveNovelRef,
    mountedRef,
    ensureReady,
    showToast,
    flushSave,
    editTextRef,
    editTargetRef,
    reviewBaselineRef,
    form,
    useOutline,
    infoControl,
    chapters,
    approvedOutlines,
    approvedOutline,
    regenerateNo,
    detail,
    activeChapter,
    selectedVersion,
    isStaleForActiveOutline,
    selectedIsFinal,
    affectedChapters,
    confirmDialog,
    loadChapters,
    loadDetail,
    openRegenerateModal,
    setGenerating,
    setGenStartAt,
    setGenIsRegenerate,
    setGenRun,
    setShowAddModal,
    setRegenerateNo,
    setShowGenRun,
    setActiveNo,
    setConfirmDialog,
    setDetail,
    setSelectedVersionId,
    setReviews,
    setReviewing,
    setReviewStartAt,
    setReviewRun,
    setShowReviewRun,
    setRevising,
    setReviseStartAt,
    setReviseRun,
    setShowReviseRun,
    setExtracting,
    setExtractedChapterNo,
    setExtractedVersionId,
    setAffectedChapters,
    setRewriteFail,
    setChapters,
    setReviewStale,
  };

  /** 「挨个重写」始终指向最新一次渲染的联动重写逻辑，避免通知里回调闭包过期。 */
  useEffect(() => {
    rerunAffectedRef.current = () => void handleRerunAffected(flowCtx);
  });

  return (
    <Loading loading={loading} className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[340px_minmax(0,1fr)] [grid-template-rows:minmax(0,1fr)]">
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
        onFinalize={() => void handleFinalizeSelected(flowCtx)}
        onExtract={() => void handleExtract(flowCtx)}
        onCopy={handleCopyContent}
        onViewInfo={() => void openInfoView()}
      />

      {/* 右侧：正文（左，占据主区）+ 评价与优化（右，常驻侧栏）并排，各自独立滚动、互不挤压；
          中窄屏（<xl）回退为上下堆叠，评价栏限高可滚动；xl 起正文与评价左右并排、各自满高独立滚动。正文与评价始终同屏可见，不再用弹窗；评价栏可折叠为窄条让正文全宽阅读。 */}
      <section
        className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden xl:flex-row xl:gap-4"
      >
        {/* ① 当前章节正文（全部版本 + 已定稿正文），显示在界面、不撑破页面高度 */}
        <ChapterContent
          detail={detail}
          activeNo={activeNo}
          selectedVersion={selectedVersion}
          selectedIsFinal={selectedIsFinal}
          editText={editText}
          onEditText={setEditText}
          saveState={saveState}
          versionOpen={versionOpen}
          onToggleVersionOpen={() => setVersionOpen((o) => !o)}
          onCloseVersionOpen={() => setVersionOpen(false)}
          aiBusy={aiBusy}
          onSelectVersion={handleSelectVersion}
          showToast={showToast}
        />

        {/* 评价与优化：右侧常驻侧栏（替代原弹窗），评价师结果与「按评价优化」与正文同屏可见；
            可点标题栏「收起」按钮折叠为窄条，正文即恢复全宽阅读；再点窄条展开。 */}
        <ReviewSidebar
          collapsed={reviewCollapsed}
          onCollapsedChange={setReviewCollapsed}
          reviewWidth={reviewWidth}
          onReviewWidth={setReviewWidth}
          detail={detail}
          reviewStale={reviewStale}
          currentReview={currentReview}
          onReview={() => void handleReview(flowCtx)}
          reviewing={reviewing}
          reviewTaskRunning={reviewTaskRunning}
          selectedVersion={selectedVersion}
          isRecentlyGenerated={isRecentlyGenerated}
          reviewBusyForChapter={reviewBusyForChapter}
          onRevise={(r, a) => void handleRevise(flowCtx, r, a)}
          revising={revising}
          onShowReviewRun={() => setShowReviewRun(true)}
          onShowReviseRun={() => setShowReviseRun(true)}
        />

        {/* 联动重写中断：已迁移为右上角全局 error Notification（writing-panel 顶部 rewriteFail 同步 effect 管理） */}
      </section>

      {/* ── 新增章节抽屉：右侧滑入的内联面板（替代居中弹窗，不遮挡正文，填写时可对照左侧正文） ── */}
      {showAddModal && (
        <AddChapterDrawer
          regenerateNo={regenerateNo}
          form={form}
          onFormChange={setForm}
          nextNo={nextNo}
          targetOutline={targetOutline}
          useOutline={useOutline}
          onToggleUseOutline={toggleUseOutline}
          generating={generating}
          onOpenInfo={openInfoModal}
          infoFilledCount={infoFilledCount}
          onGenerate={() => void handleGenerate(flowCtx)}
          onViewRun={() => setShowGenRun(true)}
          onClose={() => {
            setShowAddModal(false);
            setRegenerateNo(null);
          }}
        />
      )}

      {/* ── 信息控制弹窗（本地 draft：取消丢弃 / 清空只清本地 / 完成才提交到本章信息控制，随生成生效） ── */}
      <InfoModal
        open={showInfoModal}
        onClose={() => setShowInfoModal(false)}
        draft={infoDraft}
        effective={infoEffective}
        onDraftChange={setInfoDraft}
        onSubmit={() => {
          // 完成：把编辑结果作为「本章信息控制」，生成正文时随请求提交（后端合并生效并快照）
          setInfoControl({ ...infoDraft });
          setShowInfoModal(false);
        }}
      />

      {/* 信息控制（查看）：生成后从「本章操作」进入，只读展示本章已填信息控制与生效合并 */}
      <InfoModal
        open={infoView != null}
        onClose={() => setInfoView(null)}
        draft={infoView ?? { reader_knows: "", protagonist_knows: "", must_hide: "", hint_only: "" }}
        effective={infoViewEffective}
        onDraftChange={() => {}}
        onSubmit={() => setInfoView(null)}
        readonly
      />

      {/* 评价与优化、版本树已改为右侧常驻内联面板，不再使用弹窗 */}

      {/* ── AI 处理过程弹窗 + 定稿/提取二次确认弹窗：统一收口到 run-modals ── */}
      <RunModals
        novelId={novelId}
        showGenRun={showGenRun}
        onCloseGenRun={() => setShowGenRun(false)}
        genRun={genRun}
        genElapsed={genElapsed}
        regenerateNo={regenerateNo}
        formChapterNo={form.chapter_no}
        showReviewRun={showReviewRun}
        onCloseReviewRun={() => setShowReviewRun(false)}
        reviewRun={reviewRun}
        reviewElapsed={reviewElapsed}
        activeNo={activeNo}
        showReviseRun={showReviseRun}
        onCloseReviseRun={() => setShowReviseRun(false)}
        reviseRun={reviseRun}
        reviseElapsed={reviseElapsed}
        confirmDialog={confirmDialog}
        selectedVersion={selectedVersion}
        onConfirm={() => {
          if (confirmDialog?.kind === "extract") void doExtract(flowCtx);
          else void doFinalize(flowCtx);
        }}
        onCancel={() => setConfirmDialog(null)}
      />
      </div>
    </Loading>
  );
}
