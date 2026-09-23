"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "./modal";

interface AgentStreamModalProps {
  open: boolean;
  onClose: () => void;
  /** 弹窗标题，如「蓝图师生成过程」「大纲师生成过程」 */
  title: string;
  running: boolean;
  draftText: string;
  thinkingText: string;
  /** 是否处于错误状态（subtitle 提示用；失败消息由调用方弹 toast） */
  error?: boolean;
  /** 已用秒数（调用方用 useElapsed 计算） */
  elapsed: number;
  /** 生成中、尚无正文输出时的占位文案 */
  emptyRunningText: string;
  /** 生成完成、无正文输出时的占位文案 */
  emptyDoneText: string;
}

/**
 * 打字机逐字播放：把已经收到的文本按节奏「逐字打印」出来（而非整段整段蹦出）。
 * - 流式追加期间按积压量自动调速：积压越多打得越快，尽量跟手
 * - 生成结束 / 弹窗重新打开时立即补全全文，不做缓慢收尾
 * - 新一轮生成（文本清空）自动重置打字位置
 */
function useTypewriter(text: string, open: boolean, running: boolean): string {
  const [typed, setTyped] = useState(0);
  const typedRef = useRef(0);
  // 最新文本存 ref：SSE 流式增量高频触发 text 变化，若把 text 放进 interval 的依赖，
  // 每次更新都会先清掉再重建 interval（事件间隔常 <16ms），interval 永远来不及触发，
  // 打字机停在 0 字 → 全程只见占位文字。改为 interval 只随 [open, running] 启停，
  // 每帧从 ref 读最新长度，稳定推进、按积压量调速。
  const textRef = useRef(text);
  textRef.current = text;

  // 新一轮生成开始（文本被清空）时重置打字位置
  useEffect(() => {
    if (running && text.length === 0) {
      typedRef.current = 0;
      setTyped(0);
    }
  }, [running, text]);

  // 打字机推进：仅弹窗打开时播放；流结束后立即补全剩余文字
  useEffect(() => {
    if (!open) return;
    if (!running) {
      // 流结束：立即补全剩余文字（不做缓慢收尾）
      const len = textRef.current.length;
      if (typedRef.current !== len) {
        typedRef.current = len;
        setTyped(len);
      }
      return;
    }
    const id = setInterval(() => {
      const len = textRef.current.length;
      if (len <= 0) return;
      const backlog = len - typedRef.current;
      if (backlog <= 0) return;
      // 常规逐字约 2 字/帧（16ms ≈ 125 字/秒）；积压大时加速追赶，避免越拉越远
      let step = 2;
      if (backlog > 300) step = 12;
      else if (backlog > 100) step = 6;
      typedRef.current = Math.min(len, typedRef.current + step);
      setTyped(typedRef.current);
    }, 16);
    return () => clearInterval(id);
  }, [open, running]);

  return text.slice(0, typed);
}

/**
 * 生成过程弹窗：DeepSeek 网页版同款交互——深度思考折叠条 + 正文流式滚动，
 * 生成中自动展开思考、完成自动收起，底部实时统计已输出字数/用时。
 * 正文与思考均为打字机逐字播放效果。
 * 蓝图师 / 大纲师等流式生成共用。
 */
export default function AgentStreamModal({
  open,
  onClose,
  title,
  running,
  draftText,
  thinkingText,
  error = false,
  elapsed,
  emptyRunningText,
  emptyDoneText,
}: AgentStreamModalProps) {
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const streamRef = useRef<HTMLPreElement | null>(null);
  // 打字机逐字展示（区别于已收到的 draftText/thinkingText 总量）
  const typedDraft = useTypewriter(draftText, open, running);
  const typedThinking = useTypewriter(thinkingText, open, running);

  // 流式输出自动滚到底部（含思考过程），按打字进度滚动
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [typedDraft, typedThinking, running]);

  // 思考过程折叠块：生成中自动展开，生成完成后自动收起
  useEffect(() => {
    if (running) setThinkingOpen(true);
    else setThinkingOpen(false);
  }, [running]);

  return (
    <Modal
      open={open}
      title={title}
      subtitle={
        running
          ? "生成进行中，正文实时滚动…（用时见下方统计）"
          : error
            ? "生成出错，已通过消息提示告知原因"
            : "生成已完成"
      }
      onClose={onClose}
      maxWidth="max-w-2xl"
      fullHeight
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* 生成内容（DeepSeek 网页版同款流式输出）：思考过程折叠在模块内，下方正文实时滚动 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3.5 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h4 className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">生成内容</h4>
            <span className="font-mono text-[11px] text-zinc-400">
              {running ? `已输出 ${draftText.length} 字 · 已用时 ${elapsed}s` : `共 ${draftText.length} 字`}
            </span>
          </div>

          {/* 深度思考折叠条：生成中自动展开、完成自动收起，可点击展开/收起（豆包/DeepSeek 折叠样式） */}
          {thinkingText ? (
            <>
              <button
                type="button"
                onClick={() => setThinkingOpen((v) => !v)}
                className="flex w-full shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50/60 px-3.5 py-1.5 text-left text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <span className="relative flex h-2 w-2 shrink-0">
                  {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />}
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-400" />
                </span>
                深度思考
                <span className="ml-auto font-mono text-[11px] text-zinc-400">
                  {thinkingOpen ? "收起" : "展开"}
                </span>
              </button>
              {thinkingOpen && (
                <pre className="max-h-40 shrink-0 overflow-y-auto whitespace-pre-wrap border-b border-zinc-200 bg-zinc-50/60 px-3.5 py-2.5 font-mono text-xs leading-5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                  {typedThinking}
                </pre>
              )}
            </>
          ) : null}

          {/* 正文：打字机逐字播放 + 流式滚动输出 */}
          <pre
            ref={streamRef}
            className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap bg-zinc-50 px-4 py-3 font-mono text-xs leading-6 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {typedDraft ||
              (running ? (
                <span className="text-zinc-400 dark:text-zinc-500">{emptyRunningText}</span>
              ) : (
                <span className="text-zinc-400 dark:text-zinc-500">{emptyDoneText}</span>
              ))}
            {running && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-blue-500 align-middle" />
            )}
          </pre>
        </div>
      </div>
    </Modal>
  );
}
