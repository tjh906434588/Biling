/**
 * @file components/settings/import.tsx
 * 设定批量导入（由 settings-panel.tsx 按逻辑边界拆分）：
 * ImportItem 解析结果条目类型 + parseImportText 纯函数（把外部 AI 输出解析为批量设定条目，
 * 容错 markdown 围栏与前后多余文字；成功条目进预览列表，未解析条目标为错误提示）。
 * 注意：批量导入弹窗 UI 已拆到同目录 import-modal.tsx（纯展示 + 回调），
 * 本文件只负责解析纯函数与结果条目类型。
 */
import { ROLE_RANKS, SETTING_TYPES, STAGE_OPTIONS } from "@/constants";
import type { SettingType } from "@/lib/api";

/** 批量导入的解析结果条目（AI 输出 → 表单字段）。 */
export interface ImportItem {
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
export function parseImportText(text: string): { items: ImportItem[]; errors: string[] } {
  const validRanks = new Set<string>(ROLE_RANKS.map((r) => r.value));
  const validStages = new Set(STAGE_OPTIONS.map((s) => s.value));
  const errors: string[] = [];
  let clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  if (start >= 0 && end > start) clean = clean.slice(start, end + 1);

  let arr: unknown;
  try {
    arr = JSON.parse(clean);
  } catch {
    return { items: [], errors: ["没读出来，请检查粘贴的内容格式"] };
  }
  if (!Array.isArray(arr)) return { items: [], errors: ["内容格式不对，请粘贴 AI 输出的设定清单"] };

  const items: ImportItem[] = [];
  arr.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const type = String(r.type ?? "").trim() as SettingType;
    const name = String(r.name ?? "").trim();
    if (!SETTING_TYPES.includes(type)) {
      errors.push(`第 ${i + 1} 条：类型「${type || "(空)"}」不属于可选类型`);
      return;
    }
    if (!name) {
      errors.push(`第 ${i + 1} 条：名称为空`);
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
