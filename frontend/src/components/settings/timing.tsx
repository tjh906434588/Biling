/**
 * @file components/settings/timing.tsx
 * 「出现时机」控件（由 settings-panel.tsx 按逻辑边界拆分）：
 * - 时间线规划纯函数：orderStages / deriveStageRanges / StagePlan / Seg / TimeBlock /
 *   deriveBlocks / clampSeg / alignSegmentsToBlocks / timingStructured
 *   （按 active 蓝图分卷推导每阶段章范围，用双滑块限定时段后落为 appear_from/until 或 appear_ranges；
 *   自成体系、互不依赖 SettingsPanel 状态）；
 * - 展示组件：BlockSlider（一段独立时间范围：双滑块 + 章号跳转 + 恢复整段）与
 *   TimingBlock（生效阶段 + 限定时段，随蓝图/章节异步加载自动重排分段）。
 */
"use client";

import { useEffect, useRef } from "react";
import { STAGE_LABEL, STAGE_OPTIONS, STAGE_ORDER } from "@/constants";
import type { Blueprint } from "@/lib/api";

/** 阶段数组按固定顺序排序（未知阶段排最后）。 */
function orderStages(stages: string[]): string[] {
  return [...stages].sort((a, b) => (STAGE_ORDER[a] ?? 99) - (STAGE_ORDER[b] ?? 99));
}

/** 从 active 蓝图分卷推导每个阶段对应的章范围；无蓝图或推导失败返回 null（与后端 derive_stage 三等分一致）。 */
function deriveStageRanges(blueprint: Blueprint | null): Record<string, { from: number; to: number }> | null {
  if (!blueprint) return null;
  let total = 0;
  for (const v of blueprint.content?.volumes ?? []) {
    const rng = String(v.chapters_range ?? "");
    const m = rng.match(/(\d+)\s*[-—]\s*(\d+)/);
    if (m) total = Math.max(total, parseInt(m[2], 10));
  }
  if (total <= 0) return null;
  const e1 = Math.floor(total / 3);
  const e2 = Math.floor((total * 2) / 3);
  return {
    early: { from: 1, to: Math.max(1, e1) },
    middle: { from: Math.max(1, e1 + 1), to: Math.max(1, e2) },
    late: { from: Math.max(1, e2 + 1), to: total },
  };
}

interface StagePlan {
  hasBlueprint: boolean;
  stageRanges: Record<string, { from: number; to: number }> | null;
  maxCreated: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** 限定时段的分段表示：一段 = 一个可独立滑动的连续范围；from/until 为空串表示整段默认生效。 */
interface Seg {
  from: string;
  until: string;
}

/** 一个「时间段块」：由若干个连续阶段合并而成（如前期+中期），或单个跳跃阶段（如仅后期）。 */
interface TimeBlock {
  stages: string[];
  lo: number;
  hi: number;
}

/** 把已选阶段按连续性分成时间段块：相邻阶段合并为一段，跳跃阶段各自成段；无蓝图/阶段章数时整体为一段。 */
function deriveBlocks(
  stages: string[],
  stageRanges: Record<string, { from: number; to: number }> | null,
  maxCreated: number,
  hideSegments?: boolean,
): TimeBlock[] {
  if (stages.length === 0) return [];
  if (!stageRanges) {
    // 有蓝图但无卷：没有精确章节边界，只选前/中/后期（隐藏限定时段滑块）
    if (hideSegments) return [];
    if (maxCreated <= 0) return [];
    return [{ stages: [...stages], lo: 1, hi: maxCreated }];
  }
  const blocks: TimeBlock[] = [];
  let cur: TimeBlock | null = null;
  for (const s of orderStages(stages)) {
    const r = stageRanges[s];
    if (!r) continue;
    if (cur && STAGE_ORDER[cur.stages[cur.stages.length - 1]] + 1 === STAGE_ORDER[s]) {
      cur.stages.push(s);
      cur.lo = Math.min(cur.lo, r.from);
      cur.hi = Math.max(cur.hi, r.to);
    } else {
      if (cur) blocks.push(cur);
      cur = { stages: [s], lo: r.from, hi: r.to };
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** 把 seg 的起止章号钳制到块范围内（空串保持为空串 = 整段）。 */
function clampSeg(seg: Seg, b: TimeBlock): Seg {
  const toS = (v: string, fallback: string) =>
    v === "" || !Number.isFinite(Number(v)) ? fallback : String(clamp(Math.floor(Number(v)), b.lo, b.hi));
  return { from: toS(seg.from, ""), until: toS(seg.until, "") };
}

/** 把 segments（相对 fromBlocks 对齐）重排到 toBlocks：等长直接按位；多→单取并集；单→多按交集拆分；无法对应则重置整段。 */
function alignSegmentsToBlocks(segments: Seg[], fromBlocks: TimeBlock[], toBlocks: TimeBlock[]): Seg[] {
  if (toBlocks.length === 0) return [];
  if (fromBlocks.length === toBlocks.length) {
    return toBlocks.map((b, i) => clampSeg(segments[i] ?? { from: "", until: "" }, b));
  }
  if (toBlocks.length === 1 && fromBlocks.length > 1) {
    let from = Infinity;
    let until = -Infinity;
    for (let i = 0; i < fromBlocks.length; i++) {
      const seg = clampSeg(segments[i] ?? { from: "", until: "" }, fromBlocks[i]);
      from = Math.min(from, seg.from !== "" ? Number(seg.from) : fromBlocks[i].lo);
      until = Math.max(until, seg.until !== "" ? Number(seg.until) : fromBlocks[i].hi);
    }
    const b = toBlocks[0];
    return [{ from: from <= b.lo ? "" : String(from), until: until >= b.hi ? "" : String(until) }];
  }
  if (fromBlocks.length === 1 && toBlocks.length > 1) {
    const src = clampSeg(segments[0] ?? { from: "", until: "" }, fromBlocks[0]);
    const sLo = src.from !== "" ? Number(src.from) : fromBlocks[0].lo;
    const sHi = src.until !== "" ? Number(src.until) : fromBlocks[0].hi;
    return toBlocks.map((b) => {
      const f = Math.max(b.lo, sLo);
      const u = Math.min(b.hi, sHi);
      if (f > u) return { from: "", until: "" };
      return { from: f > b.lo ? String(f) : "", until: u < b.hi ? String(u) : "" };
    });
  }
  return toBlocks.map(() => ({ from: "", until: "" }));
}

/** 由已选阶段 + 每段起止生成 structured 的出现时机字段：单段写 appear_from/until（兼容旧数据），多段写 appear_ranges。 */
function timingStructured(
  stages: string[],
  segments: Seg[],
  plan: StagePlan,
): {
  appear_from: number | null;
  appear_until: number | null;
  appear_ranges: { from: number; until: number }[] | null;
} {
  // 有蓝图但无卷：只按阶段保存，不写精确章范围
  const blocks = deriveBlocks(
    stages,
    plan.stageRanges,
    plan.maxCreated,
    plan.hasBlueprint && !plan.stageRanges,
  );
  const segs = alignSegmentsToBlocks(segments, blocks, blocks);
  const vals = blocks.map((b, i) => ({
    from: segs[i].from !== "" ? clamp(Math.floor(Number(segs[i].from)), b.lo, b.hi) : b.lo,
    until: segs[i].until !== "" ? clamp(Math.floor(Number(segs[i].until)), b.lo, b.hi) : b.hi,
  }));
  // 有蓝图但无卷：blocks 为空 → 仅保存阶段，不保存精确章范围
  if (blocks.length === 0) return { appear_from: null, appear_until: null, appear_ranges: null };
  const narrowed = vals.some((r, i) => r.from !== blocks[i].lo || r.until !== blocks[i].hi);
  if (!narrowed) return { appear_from: null, appear_until: null, appear_ranges: null };
  if (blocks.length === 1) return { appear_from: vals[0].from, appear_until: vals[0].until, appear_ranges: null };
  return { appear_from: null, appear_until: null, appear_ranges: vals };
}

/** 一段独立的时间范围：双滑块 + 起止章号数字输入（可直接跳转）+ 恢复整段。 */
function BlockSlider({
  block,
  label,
  from,
  until,
  onChange,
}: {
  block: TimeBlock;
  label: string;
  from: string;
  until: string;
  onChange: (from: string, until: string) => void;
}) {
  const { lo, hi } = block;
  const fromNum = from !== "" ? clamp(Number(from), lo, hi) : lo;
  const untilNum = until !== "" ? clamp(Number(until), lo, hi) : hi;
  const pct = (n: number) => (hi > lo ? ((n - lo) / (hi - lo)) * 100 : 0);
  const whole = fromNum === lo && untilNum === hi;

  function setFrom(raw: string) {
    if (raw === "") {
      onChange("", until);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const c = clamp(Math.floor(n), lo, hi);
    let u = until;
    if (until !== "" && Number(until) < c) u = String(c);
    onChange(String(c), u);
  }
  function setUntil(raw: string) {
    if (raw === "") {
      onChange(from, "");
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const c = clamp(Math.floor(n), lo, hi);
    let f = from;
    if (from !== "" && Number(from) > c) f = String(c);
    onChange(f, String(c));
  }

  const rangeCls =
    "pointer-events-none absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-zinc-50 [&::-webkit-slider-thumb]:shadow dark:[&::-webkit-slider-thumb]:border-zinc-900 [&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-zinc-50 [&::-moz-range-thumb]:shadow";
  const numCls =
    "w-16 rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 text-[11px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
          {label}
          <span className="ml-1 font-normal text-zinc-400">（第{lo}–{hi}章）</span>
        </span>
        <span className="text-[11px] text-zinc-400">{whole ? "整段生效" : `第${fromNum}–${untilNum}章`}</span>
      </div>
      <div className="relative h-6">
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-zinc-200 dark:bg-zinc-700" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-900 dark:bg-zinc-100"
          style={{ left: `${pct(fromNum)}%`, width: `${Math.max(0, pct(untilNum) - pct(fromNum))}%` }}
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={1}
          value={fromNum}
          aria-label={`${label}起始章`}
          onChange={(e) => setFrom(String(Number(e.target.value)))}
          className={`${rangeCls} z-[2] [&::-webkit-slider-thumb]:bg-zinc-900 dark:[&::-webkit-slider-thumb]:bg-zinc-100 [&::-moz-range-thumb]:bg-zinc-900 dark:[&::-moz-range-thumb]:bg-zinc-100`}
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={1}
          value={untilNum}
          aria-label={`${label}结束章`}
          onChange={(e) => setUntil(String(Number(e.target.value)))}
          className={`${rangeCls} z-[1] [&::-webkit-slider-thumb]:bg-zinc-100 dark:[&::-webkit-slider-thumb]:bg-zinc-900 [&::-moz-range-thumb]:bg-zinc-100 dark:[&::-moz-range-thumb]:bg-zinc-900`}
        />
      </div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <input
          type="number"
          min={lo}
          max={hi}
          step={1}
          value={fromNum}
          aria-label={`${label}起始章（输入跳转）`}
          onChange={(e) => setFrom(e.target.value)}
          className={numCls}
        />
        <span className="text-zinc-400">–</span>
        <input
          type="number"
          min={lo}
          max={hi}
          step={1}
          value={untilNum}
          aria-label={`${label}结束章（输入跳转）`}
          onChange={(e) => setUntil(e.target.value)}
          className={numCls}
        />
        <span className="text-zinc-400">章</span>
        {!whole && (
          <button
            type="button"
            className="ml-auto text-zinc-400 underline underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300"
            onClick={() => onChange("", "")}
          >
            恢复整段
          </button>
        )}
      </div>
    </div>
  );
}

interface TimingProps {
  stages: string[];
  onStagesChange: (v: string[]) => void;
  segments: Seg[];
  onSegmentsChange: (v: Seg[]) => void;
  plan: StagePlan;
}

/** 「出现时机」控件：生效阶段（前/中/后期）+ 限定时段（按蓝图前中后期章数选；无卷蓝图只选阶段、隐藏滑块；无蓝图按已创建章节选；可多段、可输入章号跳转）。 */
function TimingBlock({ stages, onStagesChange, segments, onSegmentsChange, plan }: TimingProps) {
  // 有蓝图但无卷：没有精确章节边界 → 只选前/中/后期，隐藏「限定时段」滑块
  const hideSegments = plan.hasBlueprint && !plan.stageRanges;
  const blocks = deriveBlocks(stages, plan.stageRanges, plan.maxCreated, hideSegments);
  const prevBlocksRef = useRef<TimeBlock[]>([]);

  // 蓝图/章节异步加载后阶段块会变化：块数不一致时把旧分段重排到新块，避免越界
  useEffect(() => {
    if (blocks.length !== segments.length) {
      onSegmentsChange(alignSegmentsToBlocks(segments, prevBlocksRef.current, blocks));
    }
    prevBlocksRef.current = blocks;
  });

  function toggleStage(st: string) {
    const on = stages.includes(st);
    const next = on ? stages.filter((x) => x !== st) : [...stages, st];
    onStagesChange(next);
    onSegmentsChange(alignSegmentsToBlocks(segments, blocks, deriveBlocks(next, plan.stageRanges, plan.maxCreated, hideSegments)));
  }

  const stageRangeText = (() => {
    if (!plan.stageRanges) return "";
    return orderStages(stages)
      .map((s) => {
        const r = plan.stageRanges![s];
        return r ? `${STAGE_LABEL[s] ?? s}（第${r.from}–${r.to}章）` : "";
      })
      .filter(Boolean)
      .join("、");
  })();

  return (
    <div className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="flex items-center gap-1 text-[12px] text-zinc-600 dark:text-zinc-300">
        生效阶段
        {STAGE_OPTIONS.map((o) => {
          const on = stages.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                on
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-zinc-300 text-zinc-500 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              }`}
              onClick={() => toggleStage(o.value)}
            >
              {o.label}
            </button>
          );
        })}
        <span className="text-zinc-400">（不选 = 全程都生效）</span>
      </div>

      <div className="mt-2 flex flex-col gap-1">
        {stages.length === 0 ? (
          <p className="text-[11px] leading-4 text-zinc-400">先选择生效阶段，才能把设定限定到具体章节。</p>
        ) : blocks.length === 0 && hideSegments ? (
          <p className="text-[11px] leading-4 text-zinc-400">
            没分卷，就按前/中/后期来生效，无需限定具体章节。
          </p>
        ) : blocks.length === 0 ? (
          <p className="text-[11px] leading-4 text-zinc-400">还没有可选的章节，先写一章再回来限定。</p>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-[12px] text-zinc-600 dark:text-zinc-300">
              <span>限定时段</span>
              <span className="text-zinc-400">（整段默认生效，拖动滑块或输入章号可缩小范围）</span>
            </div>
            <div className="flex flex-col gap-2.5">
              {blocks.map((b, i) => (
                <BlockSlider
                  key={b.stages.join("+")}
                  block={b}
                  label={b.stages.map((s) => STAGE_LABEL[s] ?? s).join("+")}
                  from={segments[i]?.from ?? ""}
                  until={segments[i]?.until ?? ""}
                  onChange={(f, u) => {
                    const next = segments.map((s, j) => (j === i ? { from: f, until: u } : s));
                    onSegmentsChange(next);
                  }}
                />
              ))}
            </div>
            {plan.stageRanges ? (
              <p className="text-[11px] leading-4 text-zinc-400">
                {stageRangeText ? `阶段范围：${stageRangeText}，按全书规划章数选择。` : "按蓝图前中后期章数选择。"}
              </p>
            ) : (
              <p className="text-[11px] leading-4 text-zinc-400">
                蓝图未给出前中后期章数，按已创建章节（第1–{plan.maxCreated}章）选择。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export {
  orderStages,
  deriveStageRanges,
  deriveBlocks,
  alignSegmentsToBlocks,
  timingStructured,
  TimingBlock,
  type StagePlan,
  type Seg,
  type TimeBlock,
};
