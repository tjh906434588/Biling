"use client";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import Modal from "./modal";

interface AiRunDialogProps {
  open: boolean;
  /** 弹窗标题，如「小说家 · 第 3 章 · 生成正文」 */
  title: ReactNode;
  /** 标题下方的一行说明（可选） */
  subtitle?: ReactNode;
  /** 思考过程文字（thinking_delta，逐段追加后传入） */
  thinking: string;
  /** AI 正式输出文字（stream_delta，逐字追加后传入） */
  output: string;
  /** 是否仍在运行：true 显示"处理中"状态；false 显示"已完成" */
  running: boolean;
  onClose: () => void;
}

/**
 * AiRunDialog：AI 处理过程查看弹窗（通用组件）。
 * 调用方负责发起 runAgent 并把 thinking_delta / stream_delta 追加进 thinking / output，
 * 本组件只做流式展示 + 自动滚动到底部，因此生成正文、评价、优化等任何 AI 流程都能复用。
 */
export default function AiRunDialog({
  open,
  title,
  subtitle,
  thinking,
  output,
  running,
  onClose,
}: AiRunDialogProps) {
  const thinkRef = useRef<HTMLDivElement | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  // 内容在增长 → 自动滚到底部，保持「流式滚动」的观感
  useEffect(() => {
    const el = thinkRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thinking]);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  return (
    <Modal
      open={open}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span
            className={`flex items-center gap-1.5 text-xs ${
              running ? "text-zinc-500 dark:text-zinc-400" : "text-green-700 dark:text-green-400"
            }`}
          >
            {running ? (
              <>
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-zinc-400" />
                AI 处理中，文字实时滚动…
              </>
            ) : (
              <>
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-green-100 text-[10px] font-bold text-green-700 dark:bg-green-900 dark:text-green-300">
                  ✓
                </span>
                本次 AI 处理已完成
              </>
            )}
          </span>
          <button type="button" onClick={onClose} className="btn btn-ghost px-4 py-1.5">
            关闭
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* 思考过程：推理模型的 reasoning，先于正式输出出现 */}
        <div>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            思考过程
            {running && !thinking && (
              <span className="font-normal text-zinc-400 dark:text-zinc-500">
                模型推理中，可能需 1～3 分钟
              </span>
            )}
          </h4>
          <div
            ref={thinkRef}
            className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-[11px] leading-5 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
          >
            {thinking || (running ? "正在连接模型…" : "（本次无思考过程）")}
          </div>
        </div>

        {/* 正式输出：正文 / 评价报告等，逐字滚动 */}
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">AI 输出</h4>
          <div
            ref={outputRef}
            className="min-h-40 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm leading-7 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          >
            {output || <span className="text-zinc-400 dark:text-zinc-500">等待 AI 输出…</span>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
