/**
 * @file components/settings/helpers.ts
 * 设定条目纯函数（由 settings-panel.tsx 按逻辑边界拆分）：
 * settingMeta（读取设定的出现时机元信息：生效章范围/阶段）与 splitSetting
 * （把一条设定拆成「不可变（constitution）/ 可变（dynamic）」两栏，兼容旧数据 description+is_constitution）。
 */
import type { Setting } from "@/lib/api";

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

export { settingMeta, splitSetting };
