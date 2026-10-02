/**
 * @file settings-panel.tsx
 * 项目设置面板（工作台「设定」页）：管理小说设定集（角色/地点/势力/世界规则/物品/概念）、
 * 世界背景类型与题材、时代行业研究，并支持把外部 AI 输出批量导入设定。
 * 核心机制：设定分「不可变（constitution）/ 可变（dynamic）」两栏写入 structured 字段；
 * 出现时机按蓝图分卷推导每阶段章范围，用双滑块限定后落为 appear_from/until 或 appear_ranges；
 * 时代行业研究仅非纯架空展示（蓝图生成时自动研究，作者可查看/修改）。
 * 结构：本文件只做状态编排与组合子组件；子模块按逻辑边界拆到 components/settings/ 下——
 * timing.tsx（「出现时机」控件与时间线规划纯函数）、era.tsx（时代行业研究展示与表单字段）、
 * import.tsx（批量导入解析纯函数）、helpers.ts（设定条目纯函数）、settings-utils.ts
 * （本面板的类型与展示常量）、meta-panel.tsx（左栏：世界背景/题材 + 时代行业研究）、
 * setting-list.tsx（设定列表与条目卡片）、setting-form.tsx（新增/编辑设定弹窗）、
 * import-modal.tsx（批量导入弹窗）、era-form.tsx（编辑时代行业研究弹窗）。
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
} from "@/lib/api";
import { IMPORT_INSTRUCTION } from "@/constants";
import ConfirmDialog from "./confirm-dialog";
import Loading from "@/components/loading";
import { message } from "@/components/message";
import { copyText } from "@/utils/clipboard";
import {
  alignSegmentsToBlocks,
  deriveBlocks,
  deriveStageRanges,
  timingStructured,
  type StagePlan,
} from "./settings/timing";
import { EMPTY_ERA_FORM, eraFromForm, eraToForm, type EraFormState } from "./settings/era";
import { parseImportText, type ImportItem } from "./settings/import";
import { settingMeta, splitSetting } from "./settings/helpers";
import { EMPTY_FORM, type FormState } from "./settings/settings-utils";
import SettingsSidebar from "./settings/meta-panel";
import SettingList from "./settings/setting-list";
import SettingFormModal from "./settings/setting-form";
import ImportModal from "./settings/import-modal";
import EraEditModal from "./settings/era-form";

interface Props {
  novelId: string;
}

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
  // 已保存的背景类型与题材（load 时落盘）：与当前选中值比对，有改动才显示「保存修改」按钮
  const [savedMeta, setSavedMeta] = useState<{ bgType: Novel["background_type"]; genres: string[] }>({
    bgType: undefined,
    genres: [],
  });
  // 是否有未保存的改动：背景类型或题材与已保存值不一致（含清空）→ 标题栏右侧显示「保存修改」
  // 题材是集合语义的多选，比较不看数组顺序：取消再选中会把题材挪到末尾，顺序变化不应误报未保存
  const genresKey = (g: string[]) => [...g].sort().join("\u0000");
  const metaDirty = bgType !== savedMeta.bgType || genresKey(genres) !== genresKey(savedMeta.genres);

  // 只展示「手动/批量」设定 + 「当前生效蓝图」导入的设定；其余蓝图版本的导入设定隐藏
  const visibleSettings = settings.filter((s) => s.source !== "blueprint" || s.blueprint_id === activeBp?.id);

  // 时代行业研究：仅「现实年代 / 半架空」展示（有现实参照才研究年代×行业）；
  // 未选择背景类型或纯架空默认隐藏——不是所有小说都需要这个模块
  const showEraResearch = bgType === "realistic" || bgType === "alternate";

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
      setSavedMeta({ bgType: novel.background_type ?? undefined, genres: novel.genres ?? [] });
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

  /** 关闭「新增/编辑设定」弹窗：清空正在编辑的设定。 */
  function closeForm() {
    setShowForm(false);
    setEditing(null);
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

  /** 打开「编辑时代行业研究」弹窗：用当前研究预填表单（无研究则清空）。 */
  function handleEditEra() {
    setEraForm(eraResearch ? eraToForm(eraResearch) : EMPTY_ERA_FORM);
    setEraEditing(true);
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
      setSavedMeta({ bgType: bgType ?? undefined, genres });
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
        <SettingsSidebar
          bgType={bgType}
          onBgTypeChange={setBgType}
          genres={genres}
          onGenresChange={setGenres}
          metaBusy={metaBusy}
          metaDirty={metaDirty}
          onSaveMeta={handleSaveMeta}
          showEraResearch={showEraResearch}
          eraResearch={eraResearch}
          onEditEra={handleEditEra}
        />

        {/* 设定列表：主工作区，占满剩余高度与宽度，内容多时仅此区滚动 */}
        <SettingList
          settings={settings}
          visibleSettings={visibleSettings}
          q={q}
          onQChange={setQ}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          onAdd={openFormModal}
          onImport={openImportModal}
          onEdit={startEdit}
          onDelete={handleDelete}
        />

        {/* 新增/编辑设定弹窗 */}
        <SettingFormModal
          open={showForm}
          editing={editing}
          form={form}
          setForm={setForm}
          busy={busy}
          stagePlan={stagePlan}
          onSave={handleSave}
          onClose={closeForm}
        />

        {/* 批量导入弹窗 */}
        <ImportModal
          open={showImport}
          importText={importText}
          onImportTextChange={setImportText}
          parsed={parsed}
          importBusy={importBusy}
          onCopy={copyInstruction}
          onParse={handleParse}
          onImport={handleImport}
          onClose={() => setShowImport(false)}
        />

        {/* 编辑时代行业研究：弹窗承载表单，不打断下方设定列表的浏览（原地编辑会把整个模块顶成表单） */}
        <EraEditModal
          open={eraEditing}
          form={eraForm}
          setForm={setEraForm}
          busy={eraBusy}
          onSave={handleSaveEra}
          onClose={() => setEraEditing(false)}
        />

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
