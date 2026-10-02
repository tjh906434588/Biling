/**
 * @file use-typewriter.ts
 * 打字机逐字播放（全项目唯一的流式文本展示实现，供生成过程弹窗等流式场景共用）。
 *
 * 核心：速度跟随「模型实时到达速率」动态调整（连续、平滑）——
 * 模型/网络吐得快就快打、吐得慢就慢打，滚动节奏与模型输出速度同步，而不是固定速度。
 * 生成结束 / 重新打开时立即补全全文；新一轮生成（文本清空）自动重置打字位置与速率统计。
 */
"use client";

import { useEffect, useRef, useState } from "react";

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

export function useTypewriter(text: string, open: boolean, running: boolean): string {
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
