/**
 * @file writing/run-modals.tsx
 * 写作页三个「查看 AI 过程」弹窗（生成正文 / 评价 / 优化，统一复用蓝图、大纲页的公共
 * AgentStreamModal）+ 定稿/提取记忆层的二次确认弹窗（ConfirmDialog，替代原生 confirm）。
 * 纯展示组件：运行状态、耗时、确认配置与回调全部由 writing-panel 传入。
 */
"use client";

import AgentStreamModal from "../components/agent-stream-modal";
import ConfirmDialog from "@/components/confirm-dialog";
import type { ChapterVersion } from "@/lib/api";
import { sourceLabel } from "./chapter-tree";
import type { AiRunState, ConfirmDialogState } from "./panel-utils";

/** 弹窗组 props：运行状态与回调全部由 writing-panel 传入。 */
interface RunModalsProps {
  novelId: string;
  // 生成正文过程弹窗
  showGenRun: boolean;
  onCloseGenRun: () => void;
  genRun: AiRunState | null;
  genElapsed: number;
  regenerateNo: number | null;
  formChapterNo: number;
  // 评价过程弹窗
  showReviewRun: boolean;
  onCloseReviewRun: () => void;
  reviewRun: AiRunState | null;
  reviewElapsed: number;
  activeNo: number | null;
  // 优化过程弹窗
  showReviseRun: boolean;
  onCloseReviseRun: () => void;
  reviseRun: AiRunState | null;
  reviseElapsed: number;
  // 二次确认弹窗（定稿 / 提取记忆层）
  confirmDialog: ConfirmDialogState | null;
  selectedVersion: ChapterVersion | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 三个 AI 过程弹窗 + 二次确认弹窗（纯展示）。 */
export function RunModals({
  novelId,
  showGenRun,
  onCloseGenRun,
  genRun,
  genElapsed,
  regenerateNo,
  formChapterNo,
  showReviewRun,
  onCloseReviewRun,
  reviewRun,
  reviewElapsed,
  activeNo,
  showReviseRun,
  onCloseReviseRun,
  reviseRun,
  reviseElapsed,
  confirmDialog,
  selectedVersion,
  onConfirm,
  onCancel,
}: RunModalsProps) {
  return (
    <>
      {/* ── AI 处理过程弹窗：生成正文 / 评价 / 优化统一复用蓝图、大纲页的公共组件（DeepSeek 同款交互） ── */}
      <AgentStreamModal
        open={showGenRun}
        onClose={onCloseGenRun}
        title={`AI 写作 · 第 ${regenerateNo ?? formChapterNo} 章 · ${regenerateNo != null ? "重新生成正文" : "新增正文"}`}
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
        onClose={onCloseReviewRun}
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
        onClose={onCloseReviseRun}
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
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </>
  );
}
