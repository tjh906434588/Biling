/**
 * @file settings-panel.tsx
 * 项目设置面板（工作台「设定」页）：管理小说设定集（角色/地点/势力/世界规则/物品/概念）、
 * 世界背景类型与题材、时代行业研究，并支持把外部 AI 输出批量导入设定。
 * 核心机制：设定分「不可变（constitution）/ 可变（dynamic）」两栏写入 structured 字段；
 * 出现时机按蓝图分卷推导每阶段章范围，用双滑块限定后落为 appear_from/until 或 appear_ranges；
 * 时代行业研究仅非纯架空展示（蓝图生成时自动研究，作者可查看/修改）。
 * 结构：本文件只做状态编排与组合子组件；子模块按逻辑边界拆到 components/settings/ 下——
 * timing.tsx（「出现时机」控件与时间线规划纯函数）、era.tsx（时代行业研究）、
 * import.tsx（批量导入解析纯函数，UI 与状态强耦合留本文件）、helpers.ts（设定条目纯函数）。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createSetting,
  deleteSetting,
  getActiveBlueprint,
  getNovel,
  listChapters,
  listSettings,
  updateNovel,
  updateSetting,
  type Blueprint,
  type Novel,
  type Setting,
  type SettingType,
} from "@/lib/api";
import {
  BACKGROUND_TYPES,
  IMPORT_INSTRUCTION,
  ROLE_RANKS,
  SETTING_SPECS,
  SETTING_TYPES,
  STAGE_LABEL,
} from "@/constants";
import { BackgroundTypePicker, GenrePicker } from "@/components/novel-meta";
import InfoTip from "./info-tip";
import ConfirmDialog from "./confirm-dialog";
import Modal from "./modal";
import Loading from "@/components/loading";
import { message } from "@/components/message";
import { copyText } from "@/utils/clipboard";
import {
  alignSegmentsToBlocks,
  deriveBlocks,
  deriveStageRanges,
  orderStages,
  timingStructured,
  TimingBlock,
  type Seg,
  type StagePlan,
} from "./settings/timing";
import {
  EMPTY_ERA_FORM,
  EraField,
  EraListCard,
  eraFromForm,
  eraToForm,
  type EraFormState,
} from "./settings/era";
import { parseImportText, type ImportItem } from "./settings/import";
import { settingMeta, splitSetting } from "./settings/helpers";

const TYPE_LABEL: Record<string, string> = Object.fromEntries(SETTING_SPECS.map((s) => [s.key, s.label]));
const SPEC_OF = (t: SettingType) => SETTING_SPECS.find((s) => s.key === t) ?? SETTING_SPECS[0];

/** 角色等级：AI 据此分配篇幅与视角权重。 */
const ROLE_RANK_LABEL: Record<string, string> = Object.fromEntries(ROLE_RANKS.map((r) => [r.value, r.label]));
const ROLE_RANK_STYLE: Record<string, string> = {
  protagonist: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  major: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  minor: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  extra: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

/** 阶段标签：设定生效的故事情节阶段（可多选；不选 = 不限制）。 */
const STAGE_STYLE: Record<string, string> = {
  early: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  middle: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  late: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
};

interface Props {
  novelId: string;
}

interface FormState {
  type: SettingType;
  name: string;
  role_rank: string;
  is_background: boolean;
  constitution_text: string;
  dynamic_text: string;
  appear_segments: Seg[];
  stages: string[];
}

const EMPTY_FORM: FormState = {
  type: "character",
  name: "",
  role_rank: "protagonist",
  is_background: false,
  constitution_text: "",
  dynamic_text: "",
  appear_segments: [],
  stages: [],
};

export default function SettingsPanel({ novelId }: Props) {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // 正在编辑的设定；null = 新增模式。与 form 一起驱动「新增/编辑设定」弹窗。
  const [editing, setEditing] = useState<Setting | null>(null);
  /** 新增/编辑保存进行中 */
  const [busy, setBusy] = useState(false);
  /** 待删除的设定；非 null 时弹确认框，确认后执行删除 */
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
  // 时代行业研究（蓝图生成时自动研究，作者可查看/修改）：null=未加载，undefined=无研究
  const [eraResearch, setEraResearch] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [eraForm, setEraForm] = useState<EraFormState>(EMPTY_ERA_FORM);
  const [eraEditing, setEraEditing] = useState(false);
  const [eraBusy, setEraBusy] = useState(false);
  // 世界背景类型与题材：创建时可留空，导入蓝图时由 AI 推断引导确认，这里可直接修改
  const [bgType, setBgType] = useState<Novel["background_type"]>(undefined);
  const [genres, setGenres] = useState<string[]>([]);
  const [metaBusy, setMetaBusy] = useState(false);

  // 只展示「手动/批量」设定 + 「当前生效蓝图」导入的设定；其余蓝图版本的导入设定隐藏
  const visibleSettings = settings.filter((s) => s.source !== "blueprint" || s.blueprint_id === activeBp?.id);

  // 时代行业研究：仅非纯架空（现实年代 / 半架空）展示；纯架空不触发研究，整段隐藏
  const showEraResearch = bgType !== "pure_fantasy";

  /** 加载阶段计划：从 active 蓝图分卷推导每阶段章范围 + 已创建章节数（供「出现时机」控件使用）。 */
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

  /** 加载设定列表与小说元信息（背景类型/题材/时代研究）；搜索词或类型筛选变化时重新加载。 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [items, novel] = await Promise.all([listSettings(novelId, typeFilter || undefined, q || undefined), getNovel(novelId)]);
      setSettings(items);
      // 时代行业研究：同步加载最新值（作者在别处改过也要反映出来）
      const er = novel.era_research ?? null;
      setEraResearch(er);
      setBgType(novel.background_type ?? undefined);
      setGenres(novel.genres ?? []);
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

  /** 保存新增/编辑表单：拼 structured 字段（角色等级/背景标记/出现时机）后写入或更新。 */
  async function handleSave() {
    if (!form.name.trim()) {
      message.error("设定名称不能为空");
      return;
    }
    const constitution_text = form.constitution_text.trim();
    const dynamic_text = form.dynamic_text.trim();
    const structured: Record<string, unknown> = { constitution_text, dynamic_text };
    if (form.type === "character") structured.role_rank = form.role_rank;
    if (form.type === "faction") structured.is_background = form.is_background;
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
      is_background: st.is_background === true,
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

  /** 点击删除：先记录目标设定，交给确认弹窗。 */
  async function handleDelete(s: Setting) {
    setDelTarget(s);
  }

  /** 确认弹窗回调：真正执行删除并刷新列表。 */
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

  /** 复制「批量导入指令」到剪贴板（供发给外部 AI 使用）。 */
  async function copyInstruction() {
    try {
      await copyText(IMPORT_INSTRUCTION);
      message.success("已复制导入指令，去发给外部 AI 吧。");
    } catch {
      message.error("复制失败，请手动复制导入指令。");
    }
  }

  /** 解析粘贴的导入文本：成功条目进预览列表，未解析条目标为错误提示。 */
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

  /** 保存时代行业研究：全部清空视为清除（置 null），否则合并原对象保留 confidence 等表单外字段。 */
  async function handleSaveEra() {
    setEraBusy(true);
    try {
      const next = eraFromForm(eraForm);
      // 全部清空 = 视为清除研究；否则合并原对象（保留 confidence 等表单外字段）
      const isEmpty = Object.values(next).every(
        (v) => v === null || v === "" || (Array.isArray(v) && v.length === 0),
      );
      if (isEmpty) {
        await updateNovel(novelId, { era_research: null });
        setEraResearch(null);
      } else {
        const merged = {
          ...(eraResearch && typeof eraResearch === "object" ? eraResearch : {}),
          ...next,
        };
        await updateNovel(novelId, { era_research: merged });
        setEraResearch(merged);
      }
      setEraEditing(false);
      message.success("时代行业研究已保存");
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setEraBusy(false);
    }
  }

  /** 保存世界背景类型与题材（background_type 传 null 表示清除选择）。 */
  async function handleSaveMeta() {
    setMetaBusy(true);
    try {
      // 传 null 表示清除（暂不选择），genres 为空数组表示无题材
      await updateNovel(novelId, { background_type: bgType ?? null, genres });
      message.success("世界背景类型与题材已保存");
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setMetaBusy(false);
    }
  }

  /** 确认批量导入：逐条创建设定（source="batch"），统计成功/失败并汇总提示。 */
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-5">
        {/* 左侧参考栏：世界背景/题材 + 时代行业研究（只读参考信息），窄栏竖排，内容多时独立滚动；主区留给设定列表 */}
        <div className="flex min-h-0 flex-col gap-4 lg:w-[400px] lg:shrink-0 lg:overflow-y-auto lg:pr-1">
        {/* 世界背景类型与题材：创建时可留空，导入蓝图时 AI 按素材推断、弹窗引导作者确认；这里可直接修改 */}
        <section className="panel flex shrink-0 flex-col gap-2.5">
          <div className="panel-head !mb-2">
            <div className="flex items-center gap-1.5">
              <h3 className="panel-title">世界背景类型与题材</h3>
              <InfoTip width="w-80" side="bottom">
                <p>
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">这本书属于哪个世界背景、什么题材。</span>
                  背景类型决定签约核查口径（现实对照时代 / 半架空 / 纯架空），题材是软性写作方向。
                  不确定可以先不选，导入蓝图时 AI 会按素材推断、弹出弹窗请你确认后自动落库，你也可以在这里直接改。
                </p>
              </InfoTip>
            </div>
          </div>
          <p className="-mt-1 mb-1 panel-hint">
            {bgType || genres.length ? (
              <>
                当前：{bgType ? BACKGROUND_TYPES.find((t) => t.value === bgType)?.label ?? bgType : "未选背景"}
                {genres.length > 0 ? ` · ${genres.join("、")}` : " · 未选题材"}
              </>
            ) : (
              "暂未选择（导入蓝图时由 AI 推断确认）"
            )}
          </p>
          <div className="grid gap-3">
            <div className="flex flex-col gap-1.5">
              <p className="text-[12px] font-medium text-zinc-500">世界背景类型</p>
              <BackgroundTypePicker value={bgType} onChange={setBgType} />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-[12px] font-medium text-zinc-500">题材（可多选）</p>
              <GenrePicker value={genres} onChange={setGenres} />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={metaBusy}
              className="btn btn-primary px-3 py-1.5 text-xs"
              onClick={handleSaveMeta}
            >
              {metaBusy ? "保存中…" : "保存"}
            </button>
          </div>
        </section>

        {/* 时代行业研究：仅非纯架空（现实年代 / 半架空）展示；蓝图生成时自动研究，作者可查看/修改 */}
        {showEraResearch && (
        <section className="panel flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          <div className="panel-head !mb-0">
            <div className="flex items-center gap-1.5">
              <h3 className="panel-title">时代行业研究</h3>
              <InfoTip width="w-80" side="bottom">
                <p>
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">这本书所处的年代×行业长什么样。</span>
                  生成蓝图时自动研究一次（运行时按需生成，不依赖开发加知识包），
                  蓝图/设定/评价都会参考它，避免机构、老板、业务写得不符当时情况。
                  换一本小说会自动重新研究。你可以在这里直接查看和修改。
                </p>
              </InfoTip>
            </div>
            {eraResearch ? (
              <div className="flex items-center gap-2">
                <span className="panel-hint">生成蓝图时自动研究</span>
                {!eraEditing && (
                  <button
                    type="button"
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                    onClick={() => {
                      setEraForm(eraResearch ? eraToForm(eraResearch) : EMPTY_ERA_FORM);
                      setEraEditing(true);
                    }}
                  >
                    编辑
                  </button>
                )}
              </div>
            ) : (
              <span className="panel-hint">尚未研究（生成蓝图时自动研究）</span>
            )}
          </div>

          {eraResearch ? (
            eraEditing ? (
              <div className="flex flex-col gap-2.5">
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <EraField
                    label="开局年份"
                    hint="故事从哪一年开始"
                    placeholder="如：2000"
                    value={eraForm.story_start_year}
                    onChange={(v) => setEraForm({ ...eraForm, story_start_year: v })}
                  />
                  <EraField
                    label="行业"
                    hint="判定出的行业"
                    placeholder="如：人才中介 / 职业介绍"
                    value={eraForm.industry}
                    onChange={(v) => setEraForm({ ...eraForm, industry: v })}
                  />
                </div>
                <EraField
                  label="时代定位"
                  hint="如：2000 年代起的现代都市"
                  value={eraForm.era}
                  onChange={(v) => setEraForm({ ...eraForm, era: v })}
                />
                <EraField
                  label="判定依据"
                  hint="AI 是从哪里判断出这个年代与行业的"
                  textarea
                  rows={2}
                  value={eraForm.note}
                  onChange={(v) => setEraForm({ ...eraForm, note: v })}
                />
                <EraField
                  label="老板 / 负责人画像"
                  textarea
                  rows={2}
                  value={eraForm.boss_portrait}
                  onChange={(v) => setEraForm({ ...eraForm, boss_portrait: v })}
                />
                <EraField
                  label="地域分布特征"
                  hint="门店 / 机构通常开在哪里、为什么"
                  textarea
                  rows={2}
                  value={eraForm.location_pattern}
                  onChange={(v) => setEraForm({ ...eraForm, location_pattern: v })}
                />
                <EraField
                  label="机构典型形态"
                  hint="一行一条"
                  textarea
                  rows={3}
                  value={eraForm.organization_forms}
                  onChange={(v) => setEraForm({ ...eraForm, organization_forms: v })}
                />
                <EraField
                  label="业务范围"
                  hint="一行一条"
                  textarea
                  rows={3}
                  value={eraForm.business_list}
                  onChange={(v) => setEraForm({ ...eraForm, business_list: v })}
                />
                <EraField
                  label="行业阶段演进时间轴"
                  hint="一行一条，带起止年份"
                  textarea
                  rows={3}
                  value={eraForm.evolution}
                  onChange={(v) => setEraForm({ ...eraForm, evolution: v })}
                />
                <EraField
                  label="时代错位雷点"
                  hint="一行一条，写作红线（需带时间前提）"
                  textarea
                  rows={3}
                  value={eraForm.era_mismatch_red_flags}
                  onChange={(v) => setEraForm({ ...eraForm, era_mismatch_red_flags: v })}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={eraBusy}
                    className="btn btn-primary px-3 py-1.5 text-xs"
                    onClick={handleSaveEra}
                  >
                    {eraBusy ? "保存中…" : "保存修改"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                    onClick={() => setEraEditing(false)}
                  >
                    取消
                  </button>
                  <span className="text-[11px] text-zinc-400">
                    列表字段每行一条；全部清空并保存 = 清除这份研究
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-[12.5px]">
                  <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">开局年份</span><span className="text-zinc-700 dark:text-zinc-200">{String(eraResearch.story_start_year ?? "（未判定）")}</span></span>
                  <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">时代定位</span><span className="text-zinc-700 dark:text-zinc-200">{String(eraResearch.era ?? "（未明确）")}</span></span>
                  <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">行业</span><span className="text-zinc-700 dark:text-zinc-200">{String(eraResearch.industry ?? "（未明确）")}</span></span>
                  <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">判定</span><span className="text-zinc-500">{String(eraResearch.note ?? "—")}</span></span>
                </div>
                {Boolean(eraResearch.boss_portrait) && (
                  <p className="rounded-lg bg-sunken/40 px-3 py-2 text-[12.5px] leading-5 text-zinc-600 dark:text-zinc-300">
                    <span className="mr-2 align-middle text-[11px] font-medium text-zinc-500">老板 / 负责人画像</span>
                    {String(eraResearch.boss_portrait)}
                  </p>
                )}
                {Boolean(eraResearch.location_pattern) && (
                  <p className="rounded-lg bg-sunken/40 px-3 py-2 text-[12.5px] leading-5 text-zinc-600 dark:text-zinc-300">
                    <span className="mr-2 align-middle text-[11px] font-medium text-zinc-500">地域分布特征</span>
                    {String(eraResearch.location_pattern)}
                  </p>
                )}
                {(Array.isArray(eraResearch.organization_forms) && eraResearch.organization_forms.length > 0) ||
                 (Array.isArray(eraResearch.business_list) && eraResearch.business_list.length > 0) ||
                 (Array.isArray(eraResearch.evolution) && eraResearch.evolution.length > 0) ||
                 (Array.isArray(eraResearch.era_mismatch_red_flags) && eraResearch.era_mismatch_red_flags.length > 0) ? (
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {Array.isArray(eraResearch.organization_forms) && eraResearch.organization_forms.length > 0 && (
                      <EraListCard title="机构典型形态" tone="jade" items={eraResearch.organization_forms} />
                    )}
                    {Array.isArray(eraResearch.business_list) && eraResearch.business_list.length > 0 && (
                      <EraListCard title="业务范围" tone="dai" items={eraResearch.business_list} />
                    )}
                    {Array.isArray(eraResearch.evolution) && eraResearch.evolution.length > 0 && (
                      <EraListCard title="行业阶段演进" tone="ochre" items={eraResearch.evolution} />
                    )}
                    {Array.isArray(eraResearch.era_mismatch_red_flags) && eraResearch.era_mismatch_red_flags.length > 0 && (
                      <EraListCard title="时代错位雷点" tone="seal" items={eraResearch.era_mismatch_red_flags} warning />
                    )}
                  </div>
                ) : null}
              </div>
            )
          ) : (
            <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-[12.5px] leading-5 text-zinc-400 dark:border-zinc-700">
              现实题材下，点击「蓝图 → 生成蓝图」会自动研究这本书的年代×行业（机构形态、老板画像、业务范围等），
              之后设定与评价都会参考它；纯架空小说不触发研究。
            </p>
          )}
        </section>
        )}
        </div>

        {/* 设定列表：主工作区，占满剩余高度与宽度，内容多时仅此区滚动 */}
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
              className="btn btn-ghost px-3 py-1.5 text-xs"
              onClick={openImportModal}
            >
              批量导入
            </button>
            <button
              type="button"
              className="btn btn-primary px-3 py-1.5 text-xs"
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
                className="rounded-lg bg-sunken/40 p-3.5 dark:bg-sunken/30"
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
                      className="btn btn-ghost px-2 py-1 text-xs"
                      onClick={() => startEdit(s)}
                    >
                      编辑
                    </button>
                    <button
                      className="btn btn-ghost px-2 py-1 text-xs text-red-500"
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
              className="btn btn-ghost px-4 py-1.5 text-sm"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary px-4 py-1.5 text-sm"
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
          {form.type === "faction" && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-zinc-300 accent-amber-600"
                checked={form.is_background}
                onChange={(e) => setForm({ ...form, is_background: e.target.checked })}
              />
              <span className="text-[11px] font-medium text-zinc-500">
                背景机构（正文只提名字、无需完整档案，设定自检不再提示补齐）
              </span>
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
            className="btn btn-ghost w-full shrink-0 px-3 py-1.5 text-xs"
            onClick={copyInstruction}
          >
            复制导入指令
          </button>
          <textarea
            className="w-full shrink-0 resize-y rounded-lg border border-zinc-300 bg-zinc-50 p-2 text-[12px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            rows={10}
            placeholder='把 AI 输出的设定清单粘贴到这里（含类型、名称、设定与动态信息），可直接复制，无需手动编辑'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <button
            className="btn btn-ghost w-full shrink-0 px-3 py-1.5 text-xs"
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
                className="btn btn-primary shrink-0 px-3 py-2 text-xs"
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
