/**
 * @file agent-stream-modal.tsx
 * AI 生成过程弹窗：深度思考折叠条 + 正文流式滚动的打字机展示，蓝图师/大纲师等生成任务共用。
 * 核心机制：SSE 收到的文本经 useTypewriter 逐字播放（按积压量自动调速、流结束立即补全）；
 * 生成期间可内嵌「作者确认」面板——确认点暂停生成流程，作者答复后自动继续。
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Modal from "@/components/modal";
import {
  ConfirmPanel,
  getAuthorConfirms,
  removeConfirm,
  setInlineHost,
  subscribeAuthorConfirms,
} from "@/components/author-confirm";
import { formatElapsed } from "@/utils/format";

/** SSR 服务端快照：恒为空，且引用稳定（避免 "getServerSnapshot should be cached" 警告） */
const EMPTY_CONFIRM_SNAPSHOT: ReturnType<typeof getAuthorConfirms> = [];

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
  /** 当前工作台小说 id：非空时本弹窗作为「作者确认」的内嵌宿主，
   * 生成中出现的作者确认（方向提案/时代研究/蓝图质检等）改在弹窗内联展示，
   * 不再单独叠一层全局弹窗（避免层级被覆盖 / 误关其它弹窗）。 */
  novelId?: string;
}

/** 打字机调速参数：速度跟随「模型实时到达率」（连续动态，不再固定分档）。
 * - RATE_WINDOW_MS：到达率统计窗口（取最近这段的增量/时间估算吐字速度）
 * - MIN_RATE / MAX_RATE：显示速度边界——模型极慢/思考停顿时的保底，模型爆发时的上限
 * - RATE_SMOOTH：指数平滑系数（越大跟随越灵敏，越小越稳）
 * - CATCHUP：追赶系数（略快于到达，防止积压持续累积；≈1 时严格同步模型速度） */
const TICK_MS = 16;
const RATE_WINDOW_MS = 2500;
const MIN_RATE = 8;
const MAX_RATE = 600;
const RATE_SMOOTH = 0.35;
const CATCHUP = 1.15;

/**
 * 打字机逐字播放：把已经收到的文本按「模型实时到达速率」的节奏逐字打印（而非整段蹦出）。
 * - 速度跟随模型/网络实时吐字速率动态调整（连续、平滑）：模型吐得快就快打、吐得慢就慢打，
 *   滚动节奏与模型输出速度同步，不再是一直固定的速度；
 * - 生成结束 / 弹窗重新打开时立即补全全文，不做缓慢收尾
 * - 新一轮生成（文本清空）自动重置打字位置与速率统计
 */
function useTypewriter(text: string, open: boolean, running: boolean): string {
  const [typed, setTyped] = useState(0);
  const typedRef = useRef(0);
  // 最新文本存 ref：SSE 流式增量高频触发 text 变化，若把 text 放进 interval 的依赖，
  // 每次更新都会先清掉再重建 interval（事件间隔常 <16ms），interval 永远来不及触发，
  // 打字机停在 0 字 → 全程只见占位文字。改为 interval 只随 [open, running] 启停，
  // 每帧从 ref 读最新长度，稳定推进、按实时到达率调速。
  const textRef = useRef(text);
  // 到达快照（时间戳 + 累计长度），用于估算模型实时吐字速率；只保留统计窗口内的
  const arrivalsRef = useRef<{ t: number; len: number }[]>([]);
  // 平滑后的到达速率（字符/秒），避免瞬时波动导致打字速度忽快忽慢
  const emaRateRef = useRef(40);

  useEffect(() => {
    textRef.current = text;
    // 文本增长（流式到达新内容）时记录到达快照
    const prev = arrivalsRef.current[arrivalsRef.current.length - 1];
    if (!prev || text.length > prev.len) {
      const now = Date.now();
      arrivalsRef.current.push({ t: now, len: text.length });
      const cutoff = now - RATE_WINDOW_MS;
      while (arrivalsRef.current.length > 1 && arrivalsRef.current[1].t < cutoff) {
        arrivalsRef.current.shift();
      }
    }
  });

  // 新一轮生成开始（文本被清空）时重置打字位置与速率统计
  useEffect(() => {
    if (running && text.length === 0) {
      typedRef.current = 0;
      setTyped(0);
      arrivalsRef.current = [];
      emaRateRef.current = 40;
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
      // 实时到达率：统计窗口内「首尾到达快照」的增量 / 时间跨度；
      // 模型慢/停顿 → 速率自然衰减；新块到达 → 速率回升。连续跟随，不再固定分档。
      const now = Date.now();
      const arr = arrivalsRef.current;
      let rate = emaRateRef.current;
      if (arr.length >= 2) {
        const spanSec = Math.max(0.2, (now - arr[0].t) / 1000);
        rate = (arr[arr.length - 1].len - arr[0].len) / spanSec;
        rate = Math.max(MIN_RATE, Math.min(MAX_RATE, rate));
      }
      // 平滑 + 略快于到达（追赶系数），防止积压持续累积
      emaRateRef.current += RATE_SMOOTH * (rate - emaRateRef.current);
      // 浮点推进：模型很慢时每帧可能不足 1 字，按速率逐步累积
      typedRef.current = Math.min(len, typedRef.current + emaRateRef.current * (TICK_MS / 1000) * CATCHUP);
      setTyped(Math.floor(typedRef.current));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [open, running]);

  return text.slice(0, Math.min(Math.floor(typed), text.length));
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
  novelId,
}: AgentStreamModalProps) {
  const [thinkingOpen, setThinkingOpen] = useState(true); // 深度思考折叠条是否展开：生成中自动展开、完成后自动收起
  // 正文 / 深度思考滚动区引用：自动吸底时定位到「正在增长」的一侧的末尾
  const streamRef = useRef<HTMLPreElement | null>(null);
  const thinkingRef = useRef<HTMLPreElement | null>(null);
  // 记录上一帧已打字长度，判断是「深度思考」还是「正文」在增长，吸底到对应的末尾
  const lastDraftRef = useRef(0);
  const lastThinkingRef = useRef(0);
  // 打字机逐字展示（区别于已收到的 draftText/thinkingText 总量）
  const typedDraft = useTypewriter(draftText, open, running);
  const typedThinking = useTypewriter(thinkingText, open, running);

  // 内嵌确认宿主：弹窗打开且正在生成时注册 +1，关闭/停止/卸载时 -1。
  // 计数 > 0 时全局作者确认弹窗让位，确认随本弹窗内联展示。
  useEffect(() => {
    if (open && running && novelId) {
      setInlineHost(novelId, true);
      return () => setInlineHost(novelId, false);
    }
  }, [open, running, novelId]);

  // 当前小说的待确认项（SSR 快照恒为空数组，避免服务端渲染报错）
  const confirms = useSyncExternalStore(subscribeAuthorConfirms, getAuthorConfirms, () => EMPTY_CONFIRM_SNAPSHOT);
  const pendingConfirm = novelId ? confirms.find((c) => c.novel_id === novelId) : undefined;

  // 统一滚动模块内自动吸底：深度思考 / 正文谁在增长，就让它的末尾保持在可见区底部
  // （内容不断增长时不做任何"停留在原处"，永远显示最新）；
  // 作者确认待办出现时保持原位（作者需在确认面板操作），不强行吸底
  useEffect(() => {
    if (pendingConfirm) return;
    const draftGrew = typedDraft.length > lastDraftRef.current;
    const thinkingGrew = typedThinking.length > lastThinkingRef.current;
    lastDraftRef.current = typedDraft.length;
    lastThinkingRef.current = typedThinking.length;
    if (thinkingGrew && thinkingOpen && thinkingText) {
      thinkingRef.current?.scrollIntoView({ block: "end" });
    } else if (draftGrew) {
      streamRef.current?.scrollIntoView({ block: "end" });
    }
  }, [typedDraft, typedThinking, thinkingOpen, running, pendingConfirm, thinkingText]);

  // 思考过程折叠块：生成中自动展开，生成完成后自动收起；
  // 作者确认暂停时同样收起——生成流程已暂停、思考不再增长，把空间让给确认面板与正文
  useEffect(() => {
    if (pendingConfirm) setThinkingOpen(false);
    else if (running) setThinkingOpen(true);
    else setThinkingOpen(false);
  }, [running, pendingConfirm]);

  return (
    <Modal
      open={open}
      title={title}
      subtitle={
        running
          ? "正在生成，正文一行行显示…（用时见下方统计）"
          : error
            ? "生成出错，已通过消息提示告知原因"
            : "生成已完成"
      }
      onClose={onClose}
      maxWidth="max-w-2xl"
      fullHeight
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* 生成内容（DeepSeek 网页版同款流式输出）：
            问题确认 / 深度思考 / 正文 同属一个滚动模块，高度公用——
            任一内容变长都会把后续内容顶下去，滚动本模块即可查看，不再各自限高、各自滚动。 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-sunken/40 dark:border-zinc-800 dark:bg-sunken/30">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-sunken/70 px-3.5 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h4 className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">生成内容</h4>
            <span className="font-mono text-[11px] text-zinc-400">
              {running ? `已输出 ${draftText.length} 字 · 已用时 ${formatElapsed(elapsed)}` : `共 ${draftText.length} 字`}
            </span>
          </div>

          {/* 统一滚动区：作者确认（问题）+ 深度思考 + 正文 依序排列，共用同一高度
              作者确认（内嵌在生成内容模块顶部）：生成流程在此暂停，需手动选择后自动继续。
              色系与生成内容统一（灰阶卡片，区别于外层模块背景），
              仅用琥珀色标题 + 脉动圆点突出"这一块需要手动选择"。 */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {pendingConfirm ? (
              <div className="border-b border-zinc-200 px-3.5 py-3 dark:border-zinc-800">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  需要你确认 · 生成流程已暂停
                </div>
                <ConfirmPanel embedded confirm={pendingConfirm} onSettled={(id) => removeConfirm(id)} />
              </div>
            ) : null}

            {/* 深度思考折叠条：生成中自动展开、完成自动收起，可点击展开/收起（豆包/DeepSeek 折叠样式） */}
            {thinkingText ? (
              <>
                <button
                  type="button"
                  onClick={() => setThinkingOpen((v) => !v)}
                  className="flex w-full items-center gap-2 border-b border-zinc-200 bg-sunken/60 px-3.5 py-1.5 text-left text-xs font-medium text-zinc-500 transition-colors hover:bg-sunken/90 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  <span className="relative flex h-2 w-2 shrink-0">
                    {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />}
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-400" />
                  </span>
                  AI 思考过程
                  <span className="ml-auto font-mono text-[11px] text-zinc-400">
                    {thinkingOpen ? "收起" : "展开"}
                  </span>
                </button>
                {thinkingOpen && (
                  <pre
                    ref={thinkingRef}
                    className="whitespace-pre-wrap border-b border-zinc-200 bg-sunken/60 px-3.5 py-2.5 font-mono text-xs leading-5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400"
                  >
                    {typedThinking}
                  </pre>
                )}
              </>
            ) : null}

            {/* 正文：打字机逐字播放 + 流式滚动输出 */}
            <pre
              ref={streamRef}
              className="whitespace-pre-wrap bg-sunken/50 px-4 py-3 font-mono text-xs leading-6 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
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
      </div>
    </Modal>
  );
}
