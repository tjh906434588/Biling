"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SETTING_TYPES,
  createSetting,
  deleteSetting,
  getActiveBlueprint,
  listChapters,
  listSettings,
  updateSetting,
  type Blueprint,
  type Setting,
  type SettingType,
} from "@/lib/api";
import InfoTip from "./info-tip";
import ConfirmDialog from "./confirm-dialog";
import Modal from "./modal";
import Loading from "@/components/loading";
import { message } from "@/components/message";

const SETTING_SPECS: Array<{
  key: SettingType;
  label: string;
  hint: string;
  example: string;
  judge: string;
  name_hint: string;
  desc_hint: string;
  constitution_advice: string;
}> = [
  {
    key: "character",
    label: "角色",
    hint: "谁在故事里",
    example: "岚：沉默的占卜师，左眼能看到死者的记忆",
    judge: "会说话、有自我意识的（活物/系统有嘴也算）",
    name_hint: "岚",
    desc_hint: "如：左眼能看到死者记忆的占卜师，沉默寡言",
    constitution_advice: "性别/身份/血统/异能来源填「不可变」；性格成长填「可变」，交给记忆层跟踪。",
  },
  {
    key: "location",
    label: "地点",
    hint: "故事发生在哪",
    example: "旧王城：雾都，占卜房藏在第七街尽头",
    judge: "在哪：故事发生的场所",
    name_hint: "旧王城",
    desc_hint: "如：常年起雾，占卜房藏在第七街尽头",
    constitution_advice: "本质（位置、特征）填「不可变」；当前状态（被毁、废弃、易主）填「可变」。",
  },
  {
    key: "faction",
    label: "势力",
    hint: "组织 / 家族 / 阵营",
    example: "灰袍议会：暗中篡改王城记忆的组织",
    judge: "组织：家族/帮派/阵营",
    name_hint: "灰袍议会",
    desc_hint: "如：暗中篡改王城记忆的组织，首领身份不明",
    constitution_advice: "宗旨、根基填「不可变」；当前强弱、首领、敌友关系填「可变」。",
  },
  {
    key: "world_rule",
    label: "世界规则",
    hint: "这个世界的法则",
    example: "魔法消耗寿命，且不可逆转",
    judge: "法则：所有角色都遵守（如人人都有系统）",
    name_hint: "魔法耗尽寿命",
    desc_hint: "如：用一次魔法就折损一段寿命，不可逆转",
    constitution_advice: "世界法则基本都填「不可变」——违背即崩，AI 必须死守。",
  },
  {
    key: "item",
    label: "物品",
    hint: "有来历的道具 / 宝物",
    example: "旧王徽铜币：遇险会发烫，认得主人",
    judge: "道具：实体的、拿得到的",
    name_hint: "旧王徽铜币",
    desc_hint: "如：遇险会发烫，只认主人",
    constitution_advice: "核心功能、限制填「不可变」；在谁手里、是否损坏填「可变」。",
  },
  {
    key: "concept",
    label: "概念",
    hint: "世界观里的特有名词",
    example: "记忆刻印：记忆可以被人为写入和抹除",
    judge: "特有名词/机制（如主角独有的系统）",
    name_hint: "记忆刻印",
    desc_hint: "如：记忆可以被人为写入和抹除",
    constitution_advice: "概念的定义是恒定名词，基本都填「不可变」。",
  },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(SETTING_SPECS.map((s) => [s.key, s.label]));
const SPEC_OF = (t: SettingType) => SETTING_SPECS.find((s) => s.key === t) ?? SETTING_SPECS[0];

/** 一键复制的导入指令：发给外部 AI（豆包/DeepSeek 等），让它们按本产品格式输出设定 JSON。 */
const IMPORT_INSTRUCTION = `你是小说设定整理助手。请把用户提供的关于小说的设定描述，拆解成结构化设定条目。

【输出格式】只输出一个严格的 JSON 数组，不要任何多余文字，不要用 markdown 代码块包裹。每个元素：
{
  "type": "character 或 location 或 faction 或 world_rule 或 item 或 concept",
  "name": "设定名称",
  "constitution": "不可变内容（死规矩，AI 永不违背）",
  "dynamic": "可变内容（随剧情演变的性格/状态，没有就填空字符串）",
  "role_rank": "仅 type 为 character 时必填：protagonist 或 major 或 minor 或 extra",
  "appear_from": 5,
  "appear_until": 20,
  "stages": ["early", "late"]
}

【类型判定标准】
- character 角色：会说话、有自我意识的活物/系统
- location 地点：故事发生的场所
- faction 势力：组织/家族/阵营
- world_rule 世界规则：所有角色都遵守的法则（如人人都有系统）
- item 物品：有来历的道具/宝物
- concept 概念：世界观里的特有名词/机制

【出现时机（可选，防后期设定提前出现）】
- stages：设定生效的故事阶段（大致范围），可多选：early（前期）/ middle（中期）/ late（后期）；不写表示不限制
- appear_from / appear_until：在所选阶段内的更细限定（如「后期」里第 25~30 章才出现）；不写 = 整个所选阶段生效；必须搭配 stages 使用
- appear_ranges：可指定多段不连续范围（如跳过中期、只在前/后期出现）：[{ "from": 1, "until": 266 }, { "from": 534, "until": 800 }]；与 appear_from / appear_until 二选一，出现时以前者为准

【要求】
1. 每一条必须有 type 和 name；
2. constitution 写死规矩（身份、血统、世界法则、核心功能等）；dynamic 写可演变的（性格成长、当前状态、物品去向等），没有就留空；
3. 角色按戏份定 role_rank：主角 protagonist / 重要配角 major / 次要配角 minor / 龙套 extra；
4. 拆分要细：一个角色一条、一个地点一条，不要把多个塞进一条；
5. 后期才登场的设定（如后期创立的公司）务必标上 appear_from 和/或 stages，避免前期章节提前出现。

现在请根据用户提供的描述，输出 JSON 数组。`;

/** 批量导入的解析结果条目（AI 输出 → 表单字段）。 */
interface ImportItem {
  type: SettingType;
  name: string;
  constitution: string;
  dynamic: string;
  role_rank: string;
  appear_from: number | null;
  appear_until: number | null;
  appear_ranges: { from: number | null; until: number | null }[] | null;
  stages: string[];
}

/** 解析外部 AI 的输出文本为批量设定条目；容错 markdown 围栏与前后多余文字。 */
function parseImportText(text: string): { items: ImportItem[]; errors: string[] } {
  const validRanks = new Set(ROLE_RANKS.map((r) => r.value));
  const validStages = new Set(STAGE_OPTIONS.map((s) => s.value));
  const errors: string[] = [];
  let clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start >= 0 && end > start) clean = clean.slice(start, end + 1);

  let arr: unknown;
  try {
    arr = JSON.parse(clean);
  } catch (e) {
    return { items: [], errors: [`无法解析为 JSON：${(e as Error).message}`] };
  }
  if (!Array.isArray(arr)) return { items: [], errors: ["内容不是 JSON 数组"] };

  const items: ImportItem[] = [];
  arr.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const type = String(r.type ?? "").trim() as SettingType;
    const name = String(r.name ?? "").trim();
    if (!SETTING_TYPES.includes(type)) {
      errors.push(`第 ${i + 1} 条：type「${type || "(空)"}」不在可选类型内`);
      return;
    }
    if (!name) {
      errors.push(`第 ${i + 1} 条：name 为空`);
      return;
    }
    const constitution = String(r.constitution ?? r.constitution_text ?? "").trim();
    const dynamic = String(r.dynamic ?? r.dynamic_text ?? "").trim();
    let role_rank = String(r.role_rank ?? "").trim() || "major";
    if (!validRanks.has(role_rank)) role_rank = "major";
    // 出现时机：章范围取正整数（支持多段 appear_ranges）；stages 只留合法枚举
    const af = Number(r.appear_from);
    const au = Number(r.appear_until);
    const appear_from = Number.isFinite(af) && af > 0 ? Math.floor(af) : null;
    const appear_until = Number.isFinite(au) && au > 0 ? Math.floor(au) : null;
    let appear_ranges: { from: number | null; until: number | null }[] | null = null;
    if (Array.isArray(r.appear_ranges) && r.appear_ranges.length) {
      const rs: { from: number | null; until: number | null }[] = [];
      for (const rr of r.appear_ranges) {
        if (!rr || typeof rr !== "object") continue;
        const rro = rr as Record<string, unknown>;
        const rf = Number(rro.from);
        const ru = Number(rro.until);
        rs.push({
          from: Number.isFinite(rf) && rf > 0 ? Math.floor(rf) : null,
          until: Number.isFinite(ru) && ru > 0 ? Math.floor(ru) : null,
        });
      }
      if (rs.length) appear_ranges = rs;
    }
    const stages = Array.isArray(r.stages)
      ? r.stages.filter((x): x is string => typeof x === "string" && validStages.has(x))
      : [];
    items.push({
      type,
      name,
      constitution,
      dynamic,
      role_rank,
      appear_from: appear_ranges ? null : appear_from,
      appear_until: appear_ranges ? null : appear_until,
      appear_ranges,
      stages,
    });
  });
  return { items, errors };
}

/** 角色等级：AI 据此分配篇幅与视角权重。 */
const ROLE_RANKS = [
  { value: "protagonist", label: "主角" },
  { value: "major", label: "重要配角" },
  { value: "minor", label: "次要配角" },
  { value: "extra", label: "龙套 / 炮灰" },
];
const ROLE_RANK_LABEL: Record<string, string> = Object.fromEntries(ROLE_RANKS.map((r) => [r.value, r.label]));
const ROLE_RANK_STYLE: Record<string, string> = {
  protagonist: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  major: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  minor: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  extra: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

/** 阶段标签：设定生效的故事情节阶段（可多选；不选 = 不限制）。 */
const STAGE_OPTIONS = [
  { value: "early", label: "前期" },
  { value: "middle", label: "中期" },
  { value: "late", label: "后期" },
];
const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGE_OPTIONS.map((s) => [s.value, s.label]));
const STAGE_STYLE: Record<string, string> = {
  early: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  middle: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  late: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
};

/** 阶段固定顺序（前→中→后），用于展示排序，避免随点击顺序变化。 */
const STAGE_ORDER: Record<string, number> = { early: 0, middle: 1, late: 2 };

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
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                on
                  ? "border-transparent bg-zinc-900 text-white dark:border-transparent dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-500 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
              }`}
              onClick={() => toggleStage(o.value)}
            >
              {o.label}
            </button>
          );
        })}
        <span className="text-zinc-400">（不选不限）</span>
      </div>

      <div className="mt-2 flex flex-col gap-1">
        {stages.length === 0 ? (
          <p className="text-[11px] leading-4 text-zinc-400">先选择生效阶段，才能把设定限定到具体章节。</p>
        ) : blocks.length === 0 && hideSegments ? (
          <p className="text-[11px] leading-4 text-zinc-400">
            蓝图未分卷，设定按前/中/后期生效，无需限定具体章节。
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
                {stageRangeText ? `阶段范围：${stageRangeText}，按蓝图章数选择。` : "按蓝图前中后期章数选择。"}
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

/** 读取设定的出现时机元信息（生效章范围 / 阶段）。ranges 优先读多段 appear_ranges，其次回退单段 appear_from/until。 */
function settingMeta(s: Setting): {
  ranges: { from: number | null; until: number | null }[];
  stages: string[];
} {
  const st = (s.structured ?? {}) as Record<string, unknown>;
  const ranges: { from: number | null; until: number | null }[] = [];
  const raw = st.appear_ranges;
  if (Array.isArray(raw) && raw.length) {
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const rr = r as Record<string, unknown>;
      const f = rr.from;
      const u = rr.until;
      ranges.push({
        from: typeof f === "number" && f > 0 ? Math.floor(f) : null,
        until: typeof u === "number" && u > 0 ? Math.floor(u) : null,
      });
    }
  }
  if (ranges.length === 0) {
    const f = st.appear_from;
    const u = st.appear_until;
    const from = typeof f === "number" && f > 0 ? Math.floor(f) : null;
    const until = typeof u === "number" && u > 0 ? Math.floor(u) : null;
    if (from !== null || until !== null) ranges.push({ from, until });
  }
  return {
    ranges,
    stages: Array.isArray(st.stages) ? st.stages.filter((x): x is string => typeof x === "string") : [],
  };
}

/** 把一条设定拆成「宪法（不可变）」与「随剧情（可变）」两部分；兼容旧数据（description+is_constitution）。 */
function splitSetting(s: Setting): { con: string; dyn: string } {
  const st = (s.structured ?? {}) as Record<string, unknown>;
  // 只要 structured 里存在对应键（哪怕是空字符串）就以其为准；
  // 只有旧数据（structured 缺键）才回退到 description，避免清空可变后又被 description 兜底显示出来。
  const hasCon = typeof st.constitution_text === "string";
  const hasDyn = typeof st.dynamic_text === "string";
  const con = hasCon ? (st.constitution_text as string) : s.is_constitution ? (s.description ?? "") : "";
  const dyn = hasDyn ? (st.dynamic_text as string) : s.is_constitution ? "" : (s.description ?? "");
  return { con, dyn };
}

interface Props {
  novelId: string;
}

interface FormState {
  type: SettingType;
  name: string;
  role_rank: string;
  constitution_text: string;
  dynamic_text: string;
  appear_segments: Seg[];
  stages: string[];
}

const EMPTY_FORM: FormState = {
  type: "character",
  name: "",
  role_rank: "protagonist",
  constitution_text: "",
  dynamic_text: "",
  appear_segments: [],
  stages: [],
};

/** 复制文本到剪贴板：优先异步 Clipboard API；权限被拒（如预览 iframe 内）时回退 execCommand。 */
function copyText(text: string): Promise<void> {
  const fallback = () =>
    new Promise<void>((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) resolve();
        else reject(new Error("execCommand copy 失败"));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallback());
  }
  return fallback();
}

export default function SettingsPanel({ novelId }: Props) {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // 正在编辑的设定；null = 新增模式。与 form 一起驱动「新增/编辑设定」弹窗。
  const [editing, setEditing] = useState<Setting | null>(null);
  const [busy, setBusy] = useState(false);
  const [delTarget, setDelTarget] = useState<Setting | null>(null);
  // 出现时机所需的阶段计划（active 蓝图分卷 → 每阶段章范围）与已创建章节数
  const [stagePlan, setStagePlan] = useState<StagePlan>({ hasBlueprint: false, stageRanges: null, maxCreated: 0 });
  // 当前生效蓝图：蓝图导入的设定（source="blueprint"）按版本存储，只展示当前生效蓝图版本的，其余隐藏可切回
  const [activeBp, setActiveBp] = useState<Blueprint | null>(null);
  // 批量导入
  const [importText, setImportText] = useState("");
  const [parsed, setParsed] = useState<ImportItem[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  // 弹窗开关：新增/编辑设定 / 批量导入
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // 数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(true);

  // 只展示「手动/批量」设定 + 「当前生效蓝图」导入的设定；其余蓝图版本的导入设定隐藏
  const visibleSettings = settings.filter((s) => s.source !== "blueprint" || s.blueprint_id === activeBp?.id);

  const loadStagePlan = useCallback(async () => {
    try {
      const [bp, chapters] = await Promise.all([getActiveBlueprint(novelId), listChapters(novelId)]);
      setActiveBp(bp);
      let maxCreated = 0;
      for (const c of chapters) maxCreated = Math.max(maxCreated, c.chapter_no);
      setStagePlan({ hasBlueprint: !!bp, stageRanges: deriveStageRanges(bp), maxCreated });
    } catch {
      // 拿不到蓝图/章节时保持现状，不阻塞设定编辑
    }
  }, [novelId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await listSettings(novelId, typeFilter || undefined, q || undefined));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    void loadStagePlan();
  }, [novelId, typeFilter, q, loadStagePlan]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 打开「新增设定」弹窗：每次都是全新状态。 */
  function openFormModal() {
    setForm(EMPTY_FORM);
    setEditing(null);
    setShowForm(true);
  }

  /** 打开「批量导入」弹窗：每次都是全新状态。 */
  function openImportModal() {
    setImportText("");
    setParsed(null);
    setShowImport(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      message.error("设定名称不能为空");
      return;
    }
    const constitution_text = form.constitution_text.trim();
    const dynamic_text = form.dynamic_text.trim();
    const structured: Record<string, unknown> = { constitution_text, dynamic_text };
    if (form.type === "character") structured.role_rank = form.role_rank;
    const timing = timingStructured(form.stages, form.appear_segments, stagePlan);
    structured.appear_from = timing.appear_from;
    structured.appear_until = timing.appear_until;
    if (timing.appear_ranges) structured.appear_ranges = timing.appear_ranges;
    if (form.stages.length) structured.stages = form.stages;
    setBusy(true);
    try {
      if (editing) {
        await updateSetting(novelId, editing.id, {
          name: form.name.trim(),
          // 都清空时也要传空串把 description 清掉，不能省略字段（否则后端保留旧值）
          description: [constitution_text, dynamic_text].filter(Boolean).join("\n") || "",
          structured,
        });
      } else {
        await createSetting(novelId, {
          type: form.type,
          name: form.name.trim(),
          source: "manual",
          description: [constitution_text, dynamic_text].filter(Boolean).join("\n") || undefined,
          structured,
        });
      }
      setForm(EMPTY_FORM);
      setEditing(null);
      setShowForm(false);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 打开「编辑设定」弹窗：预填该条内容，类型不可改。 */
  function startEdit(s: Setting) {
    const { con, dyn } = splitSetting(s);
    const meta = settingMeta(s);
    const st = (s.structured ?? {}) as Record<string, unknown>;
    // 把已存的章范围按当前阶段块对齐到分段（多段拆开、单段直接对应）；无卷蓝图只按阶段预填
    const blocks = deriveBlocks(
      meta.stages,
      stagePlan.stageRanges,
      stagePlan.maxCreated,
      stagePlan.hasBlueprint && !stagePlan.stageRanges,
    );
    setForm({
      type: s.type,
      name: s.name,
      role_rank: typeof st.role_rank === "string" ? st.role_rank : "protagonist",
      constitution_text: con,
      dynamic_text: dyn,
      stages: meta.stages,
      appear_segments: alignSegmentsToBlocks(
        meta.ranges.map((r) => ({ from: r.from !== null ? String(r.from) : "", until: r.until !== null ? String(r.until) : "" })),
        blocks,
        blocks,
      ),
    });
    setEditing(s);
    setShowForm(true);
  }

  async function handleDelete(s: Setting) {
    setDelTarget(s);
  }

  async function confirmDelete() {
    if (!delTarget) return;
    const s = delTarget;
    setDelTarget(null);
    try {
      await deleteSetting(novelId, s.id);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  async function copyInstruction() {
    try {
      await copyText(IMPORT_INSTRUCTION);
      message.success("已复制导入指令，去发给外部 AI 吧。");
    } catch {
      message.error("复制失败，请手动复制导入指令。");
    }
  }

  function handleParse() {
    const { items, errors } = parseImportText(importText);
    setParsed(items);
    if (items.length) {
      if (errors.length) {
        message.warning(`解析出 ${items.length} 条；${errors.length} 条未解析。`);
      } else {
        message.success(`解析出 ${items.length} 条设定。`);
      }
    } else {
      message.error(errors.join("；") || "没有解析出有效条目。");
    }
  }

  async function handleImport() {
    if (!parsed || parsed.length === 0) return;
    setImportBusy(true);
    let ok = 0;
    const fails: string[] = [];
    for (const it of parsed) {
      try {
        const structured: Record<string, unknown> = {
          constitution_text: it.constitution,
          dynamic_text: it.dynamic,
        };
        if (it.type === "character") structured.role_rank = it.role_rank;
        if (it.appear_ranges && it.appear_ranges.length) {
          structured.appear_ranges = it.appear_ranges;
        } else {
          if (it.appear_from !== null) structured.appear_from = it.appear_from;
          if (it.appear_until !== null) structured.appear_until = it.appear_until;
        }
        if (it.stages.length) structured.stages = it.stages;
        await createSetting(novelId, {
          type: it.type,
          name: it.name,
          source: "batch",
          description: [it.constitution, it.dynamic].filter(Boolean).join("\n") || undefined,
          structured,
        });
        ok++;
      } catch (e) {
        fails.push(`${it.name}：${(e as Error).message}`);
      }
    }
    setImportBusy(false);
    setImportText("");
    setParsed(null);
    setShowImport(false);
    await load();
    if (fails.length) {
      message.error(`成功 ${ok} 条；失败 ${fails.length} 条：${fails.join("；")}`);
    } else {
      message.success(`成功导入 ${ok} 条设定。`);
    }
  }

  return (
    <Loading loading={loading} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {/* 设定列表 */}
      <section className="panel flex min-h-0 flex-1 flex-col gap-3.5">
        <div className="panel-head !mb-0">
          <div className="flex items-center gap-1.5">
            <h3 className="panel-title">设定列表</h3>
            <InfoTip width="w-80" side="bottom">
              <p>
                <span className="font-medium text-zinc-800 dark:text-zinc-100">设定 = 这本小说的「设定集」。</span>
                AI 写每一章前都会读一遍。角色、地点、世界规则都记在这里；「不可变」栏的它死守不违，其余可随剧情演变。先写主角一条就能开笔，边写边补。
              </p>
            </InfoTip>
          </div>
          <div className="flex items-center gap-2">
            <span className="panel-hint">
              共 {visibleSettings.length} 条
              {typeFilter ? ` · 只看「${TYPE_LABEL[typeFilter] ?? typeFilter}」` : ""}
            </span>
            <button
              type="button"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              onClick={openImportModal}
            >
              批量导入
            </button>
            <button
              type="button"
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              onClick={openFormModal}
            >
              新增设定
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            className="flex-1 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="搜索名称/描述…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="flex gap-1 overflow-x-auto">
            <button
              className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                typeFilter === ""
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-zinc-300 hover:border-zinc-500 dark:border-zinc-700"
              }`}
              onClick={() => setTypeFilter("")}
            >
              全部
            </button>
            {SETTING_TYPES.map((t) => (
              <button
                key={t}
                className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                  typeFilter === t
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "border border-zinc-300 hover:border-zinc-500 dark:border-zinc-700"
                }`}
                onClick={() => setTypeFilter(t)}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        {visibleSettings.length === 0 ? (
          settings.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm leading-6 text-zinc-400 dark:border-zinc-700">
              还没有设定。点击「新增设定」先加一条，建议从主角开始：
              <br />
              选择「角色」→ 名称写「岚」→ 在「可变」栏写一句外貌、性格和目的。
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm leading-6 text-zinc-400 dark:border-zinc-700">
              当前生效蓝图没有导入设定，手动/批量新增的设定也还没有。
              <br />
              可以新增手动设定。
            </div>
          )
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
            {visibleSettings.map((s) => {
              const { con, dyn } = splitSetting(s);
              const meta = settingMeta(s);
              return (
              <li
                key={s.id}
                className="rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {TYPE_LABEL[s.type] ?? s.type}
                  </span>
                  {s.source === "blueprint" && (
                    <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[11px] text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
                      蓝图导入
                    </span>
                  )}
                  {s.source === "outline" && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                      大纲注入
                    </span>
                  )}
                  <span className="text-sm font-medium">{s.name}</span>
                  {orderStages(meta.stages).map((st) => (
                    <span
                      key={st}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        STAGE_STYLE[st] ?? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}
                    >
                      {STAGE_LABEL[st] ?? st}
                    </span>
                  ))}
                  {meta.ranges.length > 0 && (
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      第{meta.ranges.map((r) => `${r.from ?? "?"}–${r.until ?? "终"}`).join("、")}章生效
                    </span>
                  )}
                  {s.type === "character" &&
                    (() => {
                      const st = (s.structured ?? {}) as Record<string, unknown>;
                      const rk = typeof st.role_rank === "string" ? st.role_rank : "";
                      if (!rk) return null;
                      return (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] ${
                            ROLE_RANK_STYLE[rk] ?? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}
                        >
                          {ROLE_RANK_LABEL[rk] ?? rk}
                        </span>
                      );
                    })()}
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      onClick={() => startEdit(s)}
                    >
                      编辑
                    </button>
                    <button
                      className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                      onClick={() => handleDelete(s)}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {(con || dyn) && (
                  <div className="mt-1.5 flex flex-col gap-1">
                      {con && (
                        <p className="text-sm text-amber-700 dark:text-amber-300">
                          <span className="mr-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                            不可变
                          </span>
                          {con}
                        </p>
                      )}
                      {dyn && (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400">
                          <span className="mr-1.5 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            可变
                          </span>
                          {dyn}
                        </p>
                      )}
                    </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 新增/编辑设定弹窗 */}
      <Modal
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setEditing(null);
        }}
        title={editing ? "编辑设定" : "新增设定"}
        subtitle="「不可变」栏 AI 永不违背，其余随剧情演变；先写主角一条就能开笔，边写边补。"
        maxWidth="max-w-xl"
        fullHeight
        footer={
          <>
            <button
              type="button"
              className="rounded-lg border border-zinc-300 px-4 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              onClick={handleSave}
              disabled={busy}
            >
              {editing ? "保存修改" : "保存设定"}
            </button>
          </>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <label className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] font-medium text-zinc-500">类型</span>
            <InfoTip>
              <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">类型怎么选？</p>
              <ul className="grid gap-y-1">
                {SETTING_SPECS.map((s) => (
                  <li key={s.key}>
                    <span className="font-medium text-zinc-600 dark:text-zinc-300">{s.label}</span>
                    ：{s.judge}
                  </li>
                ))}
              </ul>
              <p className="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <span className="font-medium text-zinc-600 dark:text-zinc-300">不可变 / 可变</span>
                ：表单分两栏——「不可变」栏的内容 AI 永不违背；「可变」栏随剧情演变（如性格成长，交给记忆层跟踪）。
                只填「不可变」栏 = 整条都不可变。
              </p>
            </InfoTip>
          </label>
          <select
            className="shrink-0 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as SettingType })}
            disabled={!!editing}
          >
            {SETTING_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]} — {SPEC_OF(t).hint}
              </option>
            ))}
          </select>
          {editing && <p className="shrink-0 text-[11px] text-zinc-400">类型不可修改（如需更换类型，删除后重建）</p>}
          <p className="shrink-0 text-[11px] text-zinc-400">完整示例：{SPEC_OF(form.type).example}</p>
          {form.type === "character" && (
            <label className="flex shrink-0 flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-500">角色等级（AI 据此分配篇幅 / 视角）</span>
              <select
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                value={form.role_rank}
                onChange={(e) => setForm({ ...form, role_rank: e.target.value })}
              >
                {ROLE_RANKS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex shrink-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-500">名称</span>
            <input
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder={`如：${SPEC_OF(form.type).name_hint}`}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="flex min-h-0 flex-1 flex-col gap-1">
            <span className="shrink-0 text-[11px] font-medium text-amber-600 dark:text-amber-400">不可变（AI 永不违背）</span>
            <textarea
              className="min-h-0 flex-1 rounded-lg border border-amber-300 bg-amber-50/40 p-3 text-sm outline-none focus:border-amber-500 dark:border-amber-800 dark:bg-amber-950/20 dark:text-zinc-100"
              placeholder="填死规矩：性别、身份、血统、世界法则这类。例：女性占卜师，左眼异能"
              rows={2}
              value={form.constitution_text}
              onChange={(e) => setForm({ ...form, constitution_text: e.target.value })}
            />
          </label>
          <label className="flex min-h-0 flex-1 flex-col gap-1">
            <span className="shrink-0 text-[11px] font-medium text-zinc-500">可变 · 随剧情（可演变）</span>
            <textarea
              className="min-h-0 flex-1 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              placeholder={SPEC_OF(form.type).desc_hint}
              rows={3}
              value={form.dynamic_text}
              onChange={(e) => setForm({ ...form, dynamic_text: e.target.value })}
            />
          </label>
          <p className="shrink-0 text-[11px] leading-4 text-zinc-400">类型提示：{SPEC_OF(form.type).constitution_advice}</p>
          {/* 出现时机：生效阶段 / 限定时段（按蓝图前中后期章数选，无蓝图时按已创建章节选） */}
          <div className="shrink-0">
            <TimingBlock
              stages={form.stages}
              onStagesChange={(v) => setForm((f) => ({ ...f, stages: v }))}
              segments={form.appear_segments}
              onSegmentsChange={(v) => setForm((f) => ({ ...f, appear_segments: v }))}
              plan={stagePlan}
            />
          </div>
        </div>
      </Modal>

      {/* 批量导入弹窗 */}
      <Modal
        open={showImport}
        onClose={() => setShowImport(false)}
        title="批量导入设定"
        subtitle="先复制指令发给外部 AI（豆包 / DeepSeek 等），再把它的输出粘贴回来，一键批量入库。"
        maxWidth="max-w-xl"
        regionScroll
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <button
            className="w-full shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={copyInstruction}
          >
            复制导入指令
          </button>
          <textarea
            className="w-full shrink-0 resize-y rounded-lg border border-zinc-300 bg-zinc-50 p-2 text-[12px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            rows={10}
            placeholder='把 AI 输出的 JSON 粘贴到这里，例如：[{"type":"character","name":"岚","constitution":"女性占卜师","dynamic":"沉默寡言"}]'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <button
            className="w-full shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={handleParse}
            disabled={!importText.trim()}
          >
            解析预览
          </button>

          {parsed && parsed.length > 0 && (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {parsed.map((it, i) => (
                  <li key={i} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {TYPE_LABEL[it.type]}
                      </span>
                      <span className="truncate text-xs font-medium">{it.name}</span>
                      {orderStages(it.stages).map((st) => (
                        <span
                          key={st}
                          className={`rounded px-1 py-0.5 text-[10px] ${
                            STAGE_STYLE[st] ?? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}
                        >
                          {STAGE_LABEL[st] ?? st}
                        </span>
                      ))}
                      {(() => {
                        const ranges =
                          it.appear_ranges && it.appear_ranges.length
                            ? it.appear_ranges
                            : it.appear_from !== null || it.appear_until !== null
                              ? [{ from: it.appear_from, until: it.appear_until }]
                              : [];
                        if (!ranges.length) return null;
                        return (
                          <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            第{ranges.map((r) => `${r.from ?? "?"}–${r.until ?? "终"}`).join("、")}章生效
                          </span>
                        );
                      })()}
                    </div>
                    {it.constitution && (
                      <p className="mt-0.5 truncate text-[11px] text-amber-700 dark:text-amber-300">不可变：{it.constitution}</p>
                    )}
                    {it.dynamic && (
                      <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">可变：{it.dynamic}</p>
                    )}
                  </li>
                ))}
              </ul>
              <button
                className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                onClick={handleImport}
                disabled={importBusy}
              >
                {importBusy ? "导入中…" : `确认导入（${parsed.length} 条）`}
              </button>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={delTarget !== null}
        title={delTarget ? `删除设定「${delTarget.name}」？` : "删除设定？"}
        message="删除后不可恢复。"
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setDelTarget(null)}
      />
      </div>
    </Loading>
  );
}
