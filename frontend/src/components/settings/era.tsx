/**
 * @file components/settings/era.tsx
 * 「时代行业研究」模块（由 settings-panel.tsx 按逻辑边界拆分）：
 * - 展示组件：EraListCard（单张清单卡，四色点缀）与 EraField（编辑表单的单个字段：输入框/多行文本）；
 * - 表单状态：EraFormState / EMPTY_ERA_FORM（与后端 JSON 存储一一对应，用中文可读字段呈现）与
 *   eraToForm / eraFromForm 转换函数（列表字段按「一行一条」展开 / 按行拆分回 JSON）。
 */
"use client";

/** 时代行业研究：单张「清单卡」。四色点缀（朱砂/靛青/竹青/赭石），嵌套卡用底色区分、不描边。 */
function EraListCard({
  title,
  items,
  tone,
  warning,
}: {
  title: string;
  items: unknown;
  tone: "jade" | "dai" | "ochre" | "seal";
  warning?: boolean;
}) {
  const list = Array.isArray(items) ? (items as string[]).map((x) => String(x)).filter(Boolean) : [];
  if (list.length === 0) return null;
  const titleCls: Record<"jade" | "dai" | "ochre" | "seal", string> = {
    jade: "text-jade",
    dai: "text-dai",
    ochre: "text-ochre",
    seal: "text-seal",
  };
  return (
    <div className={`rounded-lg bg-sunken/40 px-3 py-2.5 ${warning ? "border-l-2 border-seal" : ""}`}>
      <p className={`mb-1 text-[11px] font-semibold ${titleCls[tone]}`}>{title}</p>
      <ul className="flex flex-col gap-0.5">
        {list.map((x, i) => (
          <li
            key={i}
            className={`text-[12px] leading-5 ${warning ? "text-seal/90 dark:text-seal/80" : "text-zinc-600 dark:text-zinc-300"}`}
          >
            · {x}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 时代行业研究编辑表单：与后端 JSON 存储一一对应，但用普通人能看懂的中文字段呈现（不再直接编辑 JSON）。 */
interface EraFormState {
  story_start_year: string;
  era: string;
  industry: string;
  note: string;
  boss_portrait: string;
  location_pattern: string;
  organization_forms: string;
  business_list: string;
  evolution: string;
  era_mismatch_red_flags: string;
}

const EMPTY_ERA_FORM: EraFormState = {
  story_start_year: "",
  era: "",
  industry: "",
  note: "",
  boss_portrait: "",
  location_pattern: "",
  organization_forms: "",
  business_list: "",
  evolution: "",
  era_mismatch_red_flags: "",
};

/** 研究 JSON → 编辑表单（列表字段按「一行一条」展开成多行文本）。 */
function eraToForm(r: Record<string, unknown>): EraFormState {
  const list = (v: unknown): string =>
    Array.isArray(v) ? (v as unknown[]).map((x) => String(x ?? "")).join("\n") : "";
  return {
    story_start_year: r.story_start_year != null ? String(r.story_start_year) : "",
    era: String(r.era ?? ""),
    industry: String(r.industry ?? ""),
    note: String(r.note ?? ""),
    boss_portrait: String(r.boss_portrait ?? ""),
    location_pattern: String(r.location_pattern ?? ""),
    organization_forms: list(r.organization_forms),
    business_list: list(r.business_list),
    evolution: list(r.evolution),
    era_mismatch_red_flags: list(r.era_mismatch_red_flags),
  };
}

/** 编辑表单 → 研究 JSON（列表字段按行拆分；confidence 等表单外字段由调用方合并原对象保留）。 */
function eraFromForm(f: EraFormState): Record<string, unknown> {
  const lines = (s: string): string[] =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  const year = Number.parseInt(f.story_start_year.trim(), 10);
  return {
    story_start_year: Number.isFinite(year) ? year : null,
    era: f.era.trim(),
    industry: f.industry.trim(),
    note: f.note.trim(),
    boss_portrait: f.boss_portrait.trim(),
    location_pattern: f.location_pattern.trim(),
    organization_forms: lines(f.organization_forms),
    business_list: lines(f.business_list),
    evolution: lines(f.evolution),
    era_mismatch_red_flags: lines(f.era_mismatch_red_flags),
  };
}

/** 时代行业研究编辑表单：单个字段（输入框 / 多行文本）。 */
function EraField({
  label,
  hint,
  value,
  onChange,
  textarea = false,
  rows = 3,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  const cls =
    "w-full rounded-lg border border-zinc-300 bg-sunken/40 px-2.5 py-2 text-xs leading-5 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">
        {label}
        {hint ? <span className="ml-1.5 font-normal text-zinc-400 dark:text-zinc-500">{hint}</span> : null}
      </span>
      {textarea ? (
        <textarea
          className={`${cls} resize-y`}
          rows={rows}
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className={cls}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

export { EraListCard, EraField, EMPTY_ERA_FORM, eraToForm, eraFromForm, type EraFormState };
