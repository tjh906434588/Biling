/**
 * @file writing/use-ai-flows.ts
 * 写作页 AI 流程（从 writing-panel.tsx 按职责拆分，行为逐字不变）：
 * 正文生成（novelist）/ 评价（critic）/ 优化（reviser）/ 提取（extractor）/ 定稿 / 联动重写。
 * 所有状态与数据由面板侧持有，经 FlowCtx 传入；本 hook 只把「发起的流程」收敛到这里，
 * 让面板主文件回归「状态声明 + 派生值 + 加载 + JSX 组合」的骨架。
 * 关键机制：runAgent SSE 流式 + liveNovelRef/mountedRef 跨小说/卸载守卫；
 * 成功判定统一「不依赖 stored 回执（断流可能丢失但后端照常落库），收尾从服务端校准」。
 */
"use client";

import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import {
  createManualChapter,
  deriveManualVersion,
  getChapter,
  listChapters,
  listReviews,
  runAgent,
  selectVersion,
  type ChapterDetail,
  type ChapterListItem,
  type InfoControl,
  type Outline,
  type QualityReview,
  type SettingGap,
} from "@/lib/api";
import { sourceLabel } from "./chapter-tree";
import {
  summarizeOutline,
  validateExtractFor,
  type AiRunState,
  type ConfirmDialogState,
  type GenForm,
  type ShowToast,
} from "./panel-utils";
import { fireGapNotif, type AffectedChapter, type RewriteFailData } from "./notifications";

/** 面板侧持有的状态与回调全集：AI 流程只通过这个对象读写，避免巨量逐项传参。 */
export interface FlowCtx {
  novelId: string;
  liveNovelRef: MutableRefObject<string>;
  mountedRef: MutableRefObject<boolean>;
  ensureReady: () => void;
  showToast: ShowToast;
  flushSave: () => Promise<string | null>;
  editTextRef: MutableRefObject<string>;
  editTargetRef: MutableRefObject<{ chapterNo: number; versionId: string; source: string } | null>;
  /** 最近一次「存为新版本」派生出的版本 id（读后应清空）：确认「存为新版本」后拿最新选中版本 */
  lastDerivedVersionIdRef: MutableRefObject<string | null>;
  // ── 只读状态 ──
  form: GenForm;
  creationMode: "ai" | "manual" | "manual_rewrite";
  useOutline: boolean;
  /** 当前目标章已填的信息控制（谁知道了什么）：生成时提交为本章信息控制 */
  infoControl: InfoControl;
  chapters: ChapterListItem[];
  approvedOutlines: Outline[];
  approvedOutline: Outline | null;
  regenerateNo: number | null;
  detail: ChapterDetail | null;
  activeChapter: ChapterListItem | null;
  selectedVersion: NonNullable<ChapterDetail["versions"]>[number] | null;
  isStaleForActiveOutline: boolean;
  selectedIsFinal: boolean;
  affectedChapters: AffectedChapter[] | null;
  confirmDialog: ConfirmDialogState | null;
  // ── 加载 / 跳转回调 ──
  loadChapters: () => Promise<void>;
  loadDetail: (no: number, selectVersionId?: string | null) => Promise<void>;
  openRegenerateModal: () => void;
  // ── 写入通道（setter）──
  setGenerating: Dispatch<SetStateAction<boolean>>;
  setGenStartAt: Dispatch<SetStateAction<number | null>>;
  setGenIsRegenerate: Dispatch<SetStateAction<boolean>>;
  setGenRun: Dispatch<SetStateAction<AiRunState | null>>;
  setShowAddModal: Dispatch<SetStateAction<boolean>>;
  setRegenerateNo: Dispatch<SetStateAction<number | null>>;
  setShowGenRun: Dispatch<SetStateAction<boolean>>;
  setActiveNo: Dispatch<SetStateAction<number | null>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState | null>>;
  setDetail: Dispatch<SetStateAction<ChapterDetail | null>>;
  setSelectedVersionId: Dispatch<SetStateAction<string | null>>;
  setReviews: Dispatch<SetStateAction<QualityReview[] | null>>;
  setReviewing: Dispatch<SetStateAction<boolean>>;
  setReviewStartAt: Dispatch<SetStateAction<number | null>>;
  setReviewRun: Dispatch<SetStateAction<AiRunState | null>>;
  setShowReviewRun: Dispatch<SetStateAction<boolean>>;
  setRevising: Dispatch<SetStateAction<boolean>>;
  setReviseStartAt: Dispatch<SetStateAction<number | null>>;
  setReviseRun: Dispatch<SetStateAction<AiRunState | null>>;
  setShowReviseRun: Dispatch<SetStateAction<boolean>>;
  setExtracting: Dispatch<SetStateAction<boolean>>;
  setExtractedChapterNo: Dispatch<SetStateAction<number | null>>;
  setExtractedVersionId: Dispatch<SetStateAction<string | null>>;
  setAffectedChapters: Dispatch<SetStateAction<AffectedChapter[] | null>>;
  setRewriteFail: Dispatch<SetStateAction<RewriteFailData | null>>;
  setChapters: Dispatch<SetStateAction<ChapterListItem[]>>;
}

/** 发起正文生成（新增章节或重新生成正文，靠 regenerateNo 区分）：置生成中 → 合成本次配置 → runAgent SSE。 */
/** 从当前版本创建人工重写子版本，保留原版本并立即切换到新版本。 */
export async function handleManualRewrite(ctx: FlowCtx) {
  const { detail, selectedVersion, novelId } = ctx;
  if (!detail || !selectedVersion) {
    ctx.showToast("请先选择要人工重写的正文版本", "warning");
    return;
  }
  try {
    const version = await deriveManualVersion(novelId, detail.chapter_no, selectedVersion.id, { source: "manual_rewrite" });
    await ctx.loadChapters();
    await ctx.loadDetail(detail.chapter_no, version.id);
    ctx.showToast(`第 ${detail.chapter_no} 章已创建人工重写草稿`, "success");
  } catch (e) {
    ctx.showToast((e as Error).message, "error");
  }
}

/** 基于当前版本发起 AI 扩写：使用 novelist + mode=expand，后端统一落为 expanded 子版本，
 *  完成后自动切到新生成的扩写版本。扩写前先处理未保存编辑（人工版本落盘；AI 版本弹三选一确认）。 */
export async function handleExpand(ctx: FlowCtx) {
  const { detail: detailCtx, selectedVersion: selectedCtx, novelId, liveNovelRef, mountedRef } = ctx;
  // 扩写前先落盘未保存编辑 / 弹确认（存为新版本则派生人工子版本并切过去）；取消或失败则中止
  const savedText = await ctx.flushSave();
  if (savedText == null && ctx.editTargetRef.current != null) return;
  // 确认「存为新版本」后选中已切到新版本：从派生 id 解析最新选中版本作为扩写源
  const baseId = ctx.lastDerivedVersionIdRef.current ?? selectedCtx?.id ?? null;
  ctx.lastDerivedVersionIdRef.current = null;
  const detail = detailCtx;
  const selectedVersion =
    (baseId ? detail?.versions.find((v) => v.id === baseId) : null) ?? selectedCtx ?? null;
  if (!detail || !selectedVersion) {
    ctx.showToast("请先选择要扩写的正文版本", "warning");
    return;
  }
  const sourceContent = selectedVersion.content.trim();
  if (!sourceContent) {
    ctx.showToast("正文为空，不能扩写。", "warning");
    return;
  }
  ctx.setGenerating(true);
  ctx.setGenStartAt(Date.now());
  ctx.setGenRun({ thinking: "", output: "", running: true });
  try {
    ctx.ensureReady();
    await runAgent("novelist", novelId, {
      chapter_no: detail.chapter_no,
      mode: "expand",
      writing_mode: "expand",
      source_content: sourceContent,
      parent_version_id: selectedVersion.id,
      source: "expand",
      title: selectedVersion.title ?? undefined,
    }, (ev) => {
      if (liveNovelRef.current !== novelId || !mountedRef.current) return;
      const d = ev.data as { delta?: string; message?: string };
      if (ev.event === "thinking_delta" && d.delta) ctx.setGenRun((r) => r ? { ...r, thinking: r.thinking + d.delta } : r);
      if (ev.event === "stream_delta" && d.delta) ctx.setGenRun((r) => r ? { ...r, output: r.output + d.delta } : r);
      if (ev.event === "stream_error") ctx.showToast(d.message ?? "AI 扩写出错，请稍后重试。", "error");
    });
    if (liveNovelRef.current === novelId && mountedRef.current) {
      ctx.showToast("AI 扩写完成，已生成新的草稿子版本。", "success");
    }
  } catch (e) {
    if (liveNovelRef.current === novelId && mountedRef.current) ctx.showToast((e as Error).message, "error");
  } finally {
    ctx.setGenerating(false);
    ctx.setGenRun((r) => r ? { ...r, running: false } : r);
    if (liveNovelRef.current === novelId) {
      await ctx.loadChapters();
      let expandedVersionId: string | null = null;
      try {
        const fresh = await getChapter(novelId, detail.chapter_no);
        const expanded = [...fresh.versions]
          .filter((v) => v.source === "expanded" && v.parent_version_id === selectedVersion.id)
          .sort((a, b) => (b.version_no ?? 0) - (a.version_no ?? 0))[0];
        expandedVersionId = expanded?.id ?? null;
      } catch (e) {
        ctx.showToast((e as Error).message, "warning");
      }
      await ctx.loadDetail(detail.chapter_no, expandedVersionId);
    }
  }
}

export async function handleGenerate(
  ctx: FlowCtx,
  override?: Partial<GenForm>,
) {
  const { novelId, liveNovelRef, mountedRef, form, useOutline, approvedOutlines, regenerateNo } = ctx;
  if (ctx.creationMode === "manual_rewrite" && regenerateNo != null && ctx.selectedVersion) {
    try {
      const version = await deriveManualVersion(novelId, regenerateNo, ctx.selectedVersion.id, { source: "manual_rewrite" });
      await ctx.loadChapters();
      await ctx.loadDetail(regenerateNo, version.id);
      ctx.setShowAddModal(false);
      ctx.setRegenerateNo(null);
      ctx.showToast(`第 ${regenerateNo} 章已创建人工重写草稿`, "success");
    } catch (e) {
      ctx.showToast((e as Error).message, "error");
    }
    return;
  }
  if (ctx.creationMode === "manual" && regenerateNo == null && !override) {
    try {
      const created = await createManualChapter(novelId, { title: form.title.trim() || undefined });
      ctx.setActiveNo(created.chapter_no);
      await ctx.loadChapters();
      await ctx.loadDetail(created.chapter_no, created.versions.at(-1)?.id ?? null);
      ctx.setShowAddModal(false);
      ctx.setRegenerateNo(null);
      ctx.showToast(`第 ${created.chapter_no} 章人工草稿已创建，可以直接编辑正文。`, "success");
    } catch (e) {
      ctx.showToast((e as Error).message, "error");
    }
    return;
  }
  ctx.setGenerating(true);
  // 写后设定自检：本次生成收集到的疑似漏项（SSE setting_warning），完成后弹右上角告警通知
  let collectedGaps: SettingGap[] = [];
  ctx.setGenStartAt(Date.now());
  // 记录本次生成模式：新增章节 or 重新生成正文（弹窗关闭后 regenerateNo 会重置，按钮禁用方向靠它判断）
  ctx.setGenIsRegenerate(regenerateNo != null);
  // 弹窗保持打开、不自动关闭；生成过程通过「查看 AI 过程」按钮实时查看
  ctx.setGenRun({ thinking: "", output: "", running: true });

  // 用传入覆盖（如评价弹窗的「生成正文」）合成本次生成配置；form 保持新增弹窗的表单状态不动
  const f = override ? { ...form, ...override } : form;

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

  // 信息控制（谁知道了什么）：提交本章填的信息控制，后端按「已定稿章节链 + 本章」合并生效并快照到版本
  const ic = ctx.infoControl ?? {};
  const infoControl: Record<string, string> = {};
  for (const [k, v] of [
    ["reader_knows", ic.reader_knows],
    ["protagonist_knows", ic.protagonist_knows],
    ["must_hide", ic.must_hide],
    ["hint_only", ic.hint_only],
  ] as const) {
    if (v.trim()) infoControl[k] = v.trim();
  }
  if (Object.keys(infoControl).length > 0) params.info_control = infoControl;

  try {
    ctx.ensureReady();
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
        ctx.setGenRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
      } else if (ev.event === "stream_delta" && d.delta) {
        ctx.setGenRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
      } else if (ev.event === "stored") {
        const action = d.action as string | undefined;
        if (action === "alert") {
          ctx.showToast(
            `第 ${form.chapter_no} 章生成内容没通过检查（已记录告警）。可点「生成正文」重试。`,
            "error",
          );
        } else if (action !== "dry_run") {
          ctx.showToast(
            `第 ${f.chapter_no} 章已生成草稿（新版本），可在版本列表切换预览，满意后手动定稿。`,
            "success",
          );
        }
      } else if (ev.event === "setting_warning") {
        const items = (ev.data as { items?: SettingGap[] }).items ?? [];
        collectedGaps = items.length ? items : [];
      } else if (ev.event === "stream_error") {
        ctx.showToast(d.message ?? "AI 生成出错，请稍后重试。", "error");
      }
    });
  } catch (e) {
    if (liveNovelRef.current === novelId && mountedRef.current) ctx.showToast((e as Error).message, "error");
  } finally {
    ctx.setGenerating(false);
    ctx.setGenRun((r) => (r ? { ...r, running: false } : r));
    // 生成完成（成功或失败均视为完成）：关闭新增/重写弹窗与 AI 过程弹窗（对齐大纲页，弹窗不常驻）
    ctx.setShowAddModal(false);
    ctx.setRegenerateNo(null);
    ctx.setShowGenRun(false);
    if (liveNovelRef.current !== novelId) return; // 已切小说：不再用本小说的结果刷新/选中
    ctx.setActiveNo(f.chapter_no);
    await ctx.loadChapters();
    await ctx.loadDetail(f.chapter_no);
    // 写后设定自检命中：弹右上角常驻告警（重新生成 / 忽略）
    if (collectedGaps.length > 0) fireGapNotif(novelId, f.chapter_no, collectedGaps, ctx.openRegenerateModal);
  }
}

/** 顶部「定稿」按钮：先落盘草稿区未保存编辑并校验，再弹二次确认（自定义弹窗），确认后执行定稿。 */
export async function handleFinalizeSelected(ctx: FlowCtx) {
  // 定稿前先落盘正文草稿区未保存的编辑：定稿会同步章级正文，须基于最新内容；落盘失败则中止
  const savedText = await ctx.flushSave();
  if (savedText == null && ctx.editTargetRef.current != null) return;
  const { detail, selectedVersion, selectedIsFinal } = ctx;
  if (!detail || !selectedVersion || selectedIsFinal) return;
  if (!selectedVersion.content.trim() && !(await ctx.flushSave())?.trim()) {
    ctx.showToast("正文为空，不能定稿。请先补充正文。", "warning");
    return;
  }
  // 定稿一律需二次确认；签约未过签版本走强制定稿（红字危险弹窗，强制定稿逃生口）
  ctx.setConfirmDialog({ kind: selectedVersion.signing_blocked ? "finalize-force" : "finalize", savedText });
}

/** 二次确认通过后真正执行定稿。 */
export async function doFinalize(ctx: FlowCtx) {
  const cfg = ctx.confirmDialog;
  if (!cfg) return;
  ctx.setConfirmDialog(null);
  const { detail, selectedVersion, selectedIsFinal, novelId } = ctx;
  if (!detail || !selectedVersion || selectedIsFinal) return;
  const force = cfg.kind === "finalize-force";
  try {
    const updated = await selectVersion(novelId, detail.chapter_no, selectedVersion.id, force);
    ctx.setDetail(updated);
    ctx.setSelectedVersionId(selectedVersion.id);
    ctx.showToast(
      `第 ${updated.chapter_no} 章已定稿（第${selectedVersion.version_no}版 · ${sourceLabel(selectedVersion.source)}），可继续记进 AI 记忆或生成下一章。`,
      "success",
    );
    await ctx.loadChapters();
    try {
      ctx.setReviews(await listReviews(novelId, updated.chapter_no));
    } catch {
      ctx.setReviews(null);
    }
  } catch (e) {
    ctx.showToast((e as Error).message, "error");
  }
}

/** 提取当前选中已定稿版本入记忆层：先落盘未保存编辑 → 校验（有章/有版本/非旧大纲/已定稿）→ 二次确认。 */
export async function handleExtract(ctx: FlowCtx) {
  // 提取前先落盘正文草稿区未保存的编辑：记忆层须基于最新正文内容；落盘失败则中止
  const savedText = await ctx.flushSave();
  if (savedText == null && ctx.editTargetRef.current != null) return;
  // 提取前置校验（有章/有版本/非旧大纲/已定稿）：共用文案见 panel-utils.validateExtractFor
  const err = validateExtractFor(
    ctx.activeChapter,
    ctx.selectedVersion,
    ctx.isStaleForActiveOutline,
    ctx.selectedIsFinal,
  );
  if (err) {
    ctx.showToast(err, "warning");
    return;
  }
  // 提取记忆层二次确认：确认后才会真正发起提取（自定义弹窗，规避原生 confirm 在内嵌浏览器的异常）
  ctx.setConfirmDialog({ kind: "extract", savedText });
}

/** 二次确认通过后真正执行提取。 */
export async function doExtract(ctx: FlowCtx) {
  const cfg = ctx.confirmDialog;
  if (!cfg) return;
  ctx.setConfirmDialog(null);
  // 提取前先落盘正文草稿区未保存的编辑：记忆层须基于最新正文内容；落盘失败则中止
  const savedText = await ctx.flushSave();
  if (savedText == null && ctx.editTargetRef.current != null) return;
  // 提取前置校验（有章/有版本/非旧大纲/已定稿）：确认弹窗期间状态可能变化，执行前再校验一次
  const err = validateExtractFor(
    ctx.activeChapter,
    ctx.selectedVersion,
    ctx.isStaleForActiveOutline,
    ctx.selectedIsFinal,
  );
  if (err) {
    ctx.showToast(err, "warning");
    return;
  }
  // 校验通过后 activeChapter/selectedVersion 必非空（validateExtractFor 已保证，此处仅作 TS 收窄）
  const chapter = ctx.activeChapter!;
  const version = ctx.selectedVersion!;
  // 提取时锁定「当前章节 + 当前选中版本」，用于后续判断正文是否被切换过
  const chapterNo = chapter.chapter_no;
  const versionId = version.id;
  ctx.setExtracting(true);
  let storedSeen = false; // 是否收到 stored 回执：决定完成后从服务端校准还是直接采信回执
  const { novelId, liveNovelRef, mountedRef } = ctx;
  try {
    ctx.ensureReady();
    await runAgent(
      "extractor",
      novelId,
      { chapter_no: chapter.chapter_no, chapter_text: savedText ?? version.content },
      (ev) => {
        // 切到其他小说、或本面板已卸载（切页签）：后续回调不再弹全局提示、不再写入状态
        if (liveNovelRef.current !== novelId || !mountedRef.current) return;
        if (ev.event === "stored") {
          storedSeen = true;
          ctx.setExtractedChapterNo(chapterNo);
          ctx.setExtractedVersionId(versionId);
          // 本次重提取是否清掉了「被取代过的链条中间环」：若是，列出受影响的下游章节，
          // 提示作者重新提取对齐（根部删/改后，下游递进前提已断裂）。
          const d = ev.data as { downstream_affected?: AffectedChapter[] };
          const affected = Array.isArray(d?.downstream_affected)
            ? d.downstream_affected.filter((a) => a.chapter_no > 0)
            : [];
          ctx.setAffectedChapters(affected.length > 0 ? affected : null);
          ctx.showToast(`已把第 ${chapterNo} 章记进 AI 的长期记忆`, "success");
        } else if (ev.event === "stream_error") {
          ctx.showToast((ev.data as { message?: string }).message ?? "AI 提取出错，请稍后重试。", "error");
        }
      },
    );
  } catch (e) {
    if (liveNovelRef.current === novelId && mountedRef.current) ctx.showToast((e as Error).message, "error");
  } finally {
    ctx.setExtracting(false);
    // 提取是后台任务：SSE 连接若提前断开，stored 回执可能丢失，但后端照常落库。
    // 无论回执是否收到，都以服务端最新提取记录（extracted_version_id）校准按钮高亮，
    // 避免「已提取但按钮仍高亮」的误报；回执已收到时这里只是顺带刷新目录。
    try {
      const fresh = await listChapters(novelId);
      ctx.setChapters(fresh);
      if (liveNovelRef.current === novelId && mountedRef.current && !storedSeen) {
        const refreshed = fresh.find((c) => c.chapter_no === chapterNo);
        if (refreshed?.extracted_version_id != null && refreshed.extracted_version_id === versionId) {
          // 实际已落库（只是回执丢失）：补齐状态，熄灭按钮高亮
          ctx.setExtractedChapterNo(chapterNo);
          ctx.setExtractedVersionId(versionId);
          ctx.showToast(`已把第 ${chapterNo} 章记进 AI 的长期记忆`, "success");
        } else {
          ctx.showToast("提取未完成，请稍后重试。", "warning");
        }
      }
    } catch {
      if (liveNovelRef.current === novelId && mountedRef.current && !storedSeen) {
        ctx.showToast("提取未完成，请稍后重试。", "warning");
      }
    }
  }
}

/** 对当前选中版本发起评价（critic）：先落盘未保存编辑 → 校验（有章/有版本/非旧大纲）→ runAgent SSE 流式展示。 */
export async function handleReview(ctx: FlowCtx) {
  // 先把正文草稿区未落盘的编辑保存：评价必须基于后端最新正文（不是本地未保存的旧内容）；
  // 落盘失败（确有改动）时中止，避免对旧正文评价。
  const savedText = await ctx.flushSave();
  if (savedText == null && ctx.editTargetRef.current != null) return;
  const { detail, activeChapter, selectedVersion, isStaleForActiveOutline, approvedOutline, novelId, liveNovelRef, mountedRef } =
    ctx;
  if (!detail) {
    ctx.showToast("请先在章节目录选择一章", "warning");
    return;
  }
  if (!activeChapter) {
    ctx.showToast("请先在章节目录选择一章", "warning");
    return;
  }
  if (!selectedVersion) {
    ctx.showToast("该章尚未选定版本，无法评价。请先完成生成与选定。", "warning");
    return;
  }
  if (!(savedText ?? selectedVersion.content).trim()) {
    ctx.showToast("正文为空，不能评价。请先补充正文。", "warning");
    return;
  }
  // 旧大纲版本生成的正文只读：不能评价（防止拿旧正文的评价结果反向影响当前大纲语境的写作决策）
  if (isStaleForActiveOutline) {
    ctx.showToast(
      "当前正文基于旧版大纲生成，只能查看，不能评价。请先基于当前正在用的大纲重新生成一份正文，再对新的正文评价。",
      "warning",
    );
    return;
  }
  ctx.setReviewing(true);
  ctx.setReviews(null);
  ctx.setReviewStartAt(Date.now());
  ctx.setReviewRun({ thinking: "", output: "", running: true });
  let failed = false; // 流内失败标记（stream_error / schema 最终校验失败）：失败时不再弹完成提示
  try {
    ctx.ensureReady();
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
          ctx.setReviewRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
        } else if (ev.event === "stream_delta" && d.delta) {
          ctx.setReviewRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
        } else if (ev.event === "schema_validate" && d.status !== "ok") {
          failed = true;
          ctx.showToast("评价结果格式没通过检查，可重试。", "error");
        } else if (ev.event === "stored") {
          // 收到落库回执即先行刷新一次评价列表（早于流结束展示）；流结束后还会无条件校准一次。
          void listReviews(novelId, activeChapter.chapter_no)
            .then(ctx.setReviews)
            .catch(() => undefined);
        } else if (ev.event === "stream_error") {
          failed = true;
          ctx.showToast((ev.data as { message?: string }).message ?? "AI 评价出错，请稍后重试。", "error");
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
        ctx.setReviews(await listReviews(novelId, activeChapter.chapter_no));
      } catch {
        /* 刷新失败不阻塞完成提示 */
      }
      // 评价结果按 chapter_version_id 绑定当前版本；人工修改会派生新版本，不会污染旧评价。
      void getChapter(novelId, activeChapter.chapter_no).then(ctx.setDetail).catch(() => undefined);
      ctx.showToast(`第 ${activeChapter.chapter_no} 章评价完成，报告已展示在「评价与优化」中。`, "success");
    }
  } catch (e) {
    if (liveNovelRef.current === novelId && mountedRef.current) ctx.showToast((e as Error).message, "error");
  } finally {
    ctx.setReviewing(false);
    ctx.setReviewRun((r) => (r ? { ...r, running: false } : r));
    ctx.setShowReviewRun(false);
  }
}

/** 根部关系被删/改后，按序串行处理受影响的下游章节：逐章重写正文（novelist），任一章失败即停止。 */
export async function handleRerunAffected(ctx: FlowCtx) {
  const { affectedChapters, approvedOutlines, chapters, novelId, liveNovelRef, mountedRef } = ctx;
  if (!affectedChapters || affectedChapters.length === 0) return;
  const target = affectedChapters.map((a) => a.chapter_no); // 按受影响章节逐个处理
  ctx.setAffectedChapters(null); // 按钮点击后通知立即关闭
  ctx.setRewriteFail(null);
  try {
    ctx.ensureReady();
    let failedChapter: number | null = null;
    const doneRewrite: number[] = [];
    for (const no of target) {
      // 处理过程中切到其他小说、或本面板已卸载（切页签）：立即停止，不弹任何本小说的提示
      if (liveNovelRef.current !== novelId || !mountedRef.current) return;
      const o = approvedOutlines.find((x) => x.chapter_no === no) ?? null;
      const ch = chapters.find((c) => c.chapter_no === no) ?? null;
      // ── 1. 重写正文（按当前大纲，不按评价）──
      // 与真人点「生成正文」一致：只更新后台状态，弹窗由作者手动点「查看 AI 过程」查看
      ctx.setGenRun({ thinking: "", output: "", running: true });
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
              ctx.setGenRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
            } else if (ev.event === "stream_delta" && d.delta) {
              ctx.setGenRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
            } else if (ev.event === "stream_error") {
              failedChapter = no;
              ctx.showToast((ev.data as { message?: string }).message ?? `第 ${no} 章重写出错`, "error");
            }
          },
        );
      } catch (e) {
        if (liveNovelRef.current !== novelId || !mountedRef.current) return;
        failedChapter = no;
        ctx.showToast((e as Error).message, "error");
      } finally {
        ctx.setGenRun((r) => (r ? { ...r, running: false } : r));
      }
      if (failedChapter != null) break;
      doneRewrite.push(no);
      // 联动重写只生成草稿：不自动「提取→记忆层」，作者查看正文满意后手动定稿再提取
      // 已切页签（面板卸载）：本页不再弹居中提示，跨页完成由全局右上角通知兜底
      if (liveNovelRef.current === novelId && mountedRef.current) {
        ctx.showToast(`第 ${no} 章已重写完成（草稿），可查看并手动定稿`, "success");
      }
    }

    await ctx.loadChapters();
    if (liveNovelRef.current !== novelId || !mountedRef.current) return; // 已切小说/已切页签：不再弹本小说的汇总提示
    if (failedChapter != null) {
      // 失败即停止：列出「正文未重写」的章节，交作者手动补齐（含失败后还没轮到处理的章节）
      const remainingRewrite = target.filter((n) => !doneRewrite.includes(n));
      ctx.setRewriteFail({ failedChapter, remainingRewrite, remainingExtract: [] });
      const tip = [];
      if (remainingRewrite.length > 0) tip.push(`正文未重写：第 ${remainingRewrite.join("、")} 章`);
      ctx.showToast(
        `第 ${failedChapter} 章处理失败，自动连续处理已停止。${tip.length > 0 ? `剩余 ${tip.join("；")}，请手动补齐。` : ""}`,
        "error",
      );
    } else {
      ctx.showToast(`已为第 ${target.join("、")} 章生成草稿，可逐个查看并手动定稿`, "success");
    }
  } catch (e) {
    if (liveNovelRef.current === novelId && mountedRef.current) ctx.showToast((e as Error).message, "error");
  }
}

/** 按评价报告逐条优化本章正文（修订师），修订版直接定稿为新版本。 */
export async function handleRevise(
  ctx: FlowCtx,
  review: QualityReview,
  authorInput?: { note?: string; disagreements?: Record<number, string> },
) {
  // 先把正文草稿区未落盘的编辑保存：优化基于最新正文；落盘失败（确有改动）时中止
  const savedText = await ctx.flushSave();
  if (savedText == null && ctx.editTargetRef.current != null) return;
  const {
    detail,
    selectedVersion,
    isStaleForActiveOutline,
    novelId,
    liveNovelRef,
    mountedRef,
    useOutline,
    approvedOutline,
    form,
  } = ctx;
  // 章节归属以当前详情（detail）为准：selectedVersion 与 detail 同源，避免目录高亮与详情错位时
  // 把优化产物挂到目录高亮章（旧 bug：详情已是第4章、目录仍高亮第3章 → 修订版写进第3章版本树）。
  if (!detail) {
    ctx.showToast("请先在章节目录选择一章", "warning");
    return;
  }
  if (!selectedVersion) {
    ctx.showToast("该章尚未选定版本，无法优化。请先完成生成与选定。", "warning");
    return;
  }
  // 旧大纲版本生成的正文只读：不能修订（与评价同口径，防止把旧正文基于旧大纲再改出一版）
  if (isStaleForActiveOutline) {
    ctx.showToast(
      "当前正文基于旧版大纲生成，只能查看，不能优化。请先基于当前正在用的大纲重新生成一份正文，再评价优化。",
      "warning",
    );
    return;
  }
  if (review.chapter_version_id !== selectedVersion.id) {
    ctx.showToast(
      `这条评价是对第${review.version_no ?? "?"}版写的，不是当前选中的正文。请先选中对应版本，或对当前正文重新评价。`,
      "warning",
    );
    return;
  }
  ctx.setRevising(true);
  // 写后设定自检：本次优化收集到的疑似漏项（SSE setting_warning），完成后弹右上角告警通知
  let collectedGaps: SettingGap[] = [];
  ctx.setReviseStartAt(Date.now());
  ctx.setReviseRun({ thinking: "", output: "", running: true });
  let failed = false; // 流内失败标记（stream_error / schema 最终校验失败）：失败时不再弹完成提示、不关闭弹窗
  try {
    ctx.ensureReady();
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
          ctx.setReviseRun((r) => (r ? { ...r, thinking: r.thinking + d.delta } : r));
        } else if (ev.event === "stream_delta" && d.delta) {
          ctx.setReviseRun((r) => (r ? { ...r, output: r.output + d.delta } : r));
        } else if (ev.event === "setting_warning") {
          const items = (ev.data as { items?: SettingGap[] }).items ?? [];
          collectedGaps = items.length ? items : [];
        } else if (ev.event === "schema_validate" && d.status !== "ok") {
          failed = true;
          ctx.showToast("优化结果格式没通过检查，可重试。", "error");
        } else if (ev.event === "stream_error") {
          failed = true;
          ctx.showToast((ev.data as { message?: string }).message ?? "AI 优化出错，请稍后重试。", "error");
        }
      },
      undefined,
      false,
      15 * 60 * 1000, // 连接超时兜底：超过 15 分钟中断显示（后端任务照常跑完落库，刷新可见），避免永久"思考中"
    );
    // 优化完成：统一在流结束后弹完成提示（与正文生成成功一致的居中 success）。
    // 回执可能因 SSE 断流丢失但后端照常落库，故按「流正常结束且未失败」提示，不依赖 stored。
    if (liveNovelRef.current === novelId && mountedRef.current && !failed) {
      ctx.showToast(
        `已按评价问题优化第 ${detail.chapter_no} 章，新版本为草稿，请手动定稿。`,
        "success",
      );
    }
  } catch (e) {
    if (liveNovelRef.current === novelId && mountedRef.current) ctx.showToast((e as Error).message, "error");
  } finally {
    ctx.setRevising(false);
    ctx.setReviseRun((r) => (r ? { ...r, running: false } : r));
    ctx.setShowReviseRun(false);
    if (liveNovelRef.current !== novelId) return; // 已切小说：不再用本小说的结果刷新/选中
    ctx.setActiveNo(detail.chapter_no);
    await ctx.loadChapters();
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
    await ctx.loadDetail(detail.chapter_no, selectNewVersionId);
    // 写后设定自检命中：弹右上角常驻告警（重新生成 / 忽略）
    if (!failed && collectedGaps.length > 0)
      fireGapNotif(novelId, detail.chapter_no, collectedGaps, ctx.openRegenerateModal);
  }
}
