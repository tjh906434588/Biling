"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteRoute,
  getDefaultModel,
  listModelCatalog,
  listRoutes,
  upsertRoute,
  type CatalogProvider,
  type DefaultModel,
  type ModelRoute,
} from "@/lib/api";
import Modal from "./modal";
import ModelPickerModal from "./model-picker-modal";
import Loading from "@/components/loading";
import { useAiStatus } from "@/lib/ai-status";
import { message } from "@/components/message";

/** 可在高级设置里按任务类型指定模型的四类任务 */
type TaskKey = "setting" | "creation" | "review" | "extract";
const TASK_TYPES: Array<{ key: TaskKey; label: string; hint: string }> = [
  { key: "setting", label: "设定", hint: "蓝图师/大纲师：世界设定与章节大纲" },
  { key: "creation", label: "创作", hint: "小说家：章节正文创作" },
  { key: "review", label: "评价", hint: "评价师：质量审稿（可单独换更强模型）" },
  { key: "extract", label: "提取", hint: "提取师/风格学习：记忆抽取与风格提炼" },
];

/** 四类任务各自的配置表单（provider/model/temperature；留空 = 用默认模型） */
type TaskForm = Record<TaskKey, { provider: string; model: string; temperature: string }>;
const EMPTY_TASK_FORMS: TaskForm = {
  setting: { provider: "", model: "", temperature: "" },
  creation: { provider: "", model: "", temperature: "" },
  review: { provider: "", model: "", temperature: "" },
  extract: { provider: "", model: "", temperature: "" },
};

export default function ModelsPanel() {
  const { refresh: refreshAiStatus } = useAiStatus();
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [loading, setLoading] = useState(true);
  // 模型目录 / 默认模型加载中：遮罩过渡，加载完成后解除
  const [loadingModels, setLoadingModels] = useState(true);
  // ---- 高级设置弹窗：四类任务各自配置 ----
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [formByTask, setFormByTask] = useState<TaskForm>(EMPTY_TASK_FORMS);

  // ---- 模型接入：弹窗驱动（参考 TRAE「添加模型」：自定义模型置顶 + 预设服务商） ----
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [defaultModel, setDefaultModelState] = useState<DefaultModel | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRoutes(await listRoutes());
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [cat, def] = await Promise.all([listModelCatalog(), getDefaultModel()]);
      setCatalog(cat);
      setDefaultModelState(def);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadModels();
  }, [load, loadModels]);

  const openPicker = (provider?: string) => {
    setPendingProvider(provider ?? null);
    setPickerOpen(true);
  };

  /** 页面服务商状态点进来时，定位到该服务商详情。 */
  const initialProvider = useMemo(
    () => (pendingProvider ? catalog.find((p) => p.provider === pendingProvider) ?? null : null),
    [pendingProvider, catalog],
  );

  const num = (v: string | number): number | null => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /** 已接入的服务商/模型（预设服务商 enabledModels + 自定义模型），供高级设置路由下拉选择。 */
  const accessProviders = useMemo(
    () => catalog.filter((p) => (p.enabledModels?.length ?? 0) > 0 || p.custom),
    [catalog],
  );
  /** 某服务商下可选模型（自定义模型 + 预设服务商已启用模型）。 */
  const modelsFor = (provider: string) => {
    const p = catalog.find((x) => x.provider === provider);
    if (!p) return [];
    if (p.custom) return p.models.map((m) => ({ model: m.id, label: m.label }));
    return (p.enabledModels ?? []).map((e) => ({ model: e.model, label: e.label || e.model }));
  };

  /** 打开高级设置弹窗：用现有路由预填四类表单；服务商/模型已失效的留空（= 恢复默认）。 */
  const openAdvanced = () => {
    const init: TaskForm = { ...EMPTY_TASK_FORMS };
    for (const t of TASK_TYPES) {
      const r = routes.find((x) => x.task_type === t.key);
      if (!r) continue;
      const provOk = accessProviders.some((p) => p.provider === r.provider);
      const modelOk = provOk && modelsFor(r.provider).some((m) => m.model === r.model);
      init[t.key] = {
        provider: provOk ? r.provider : "",
        model: modelOk ? r.model : "",
        temperature: r.temperature != null ? String(r.temperature) : "",
      };
    }
    setFormByTask(init);
    setAdvancedOpen(true);
  };

  /** 更新某一任务类型的配置表单。 */
  const setTask = (
    key: TaskKey,
    patch: Partial<{ provider: string; model: string; temperature: string }>,
  ) => setFormByTask((f) => ({ ...f, [key]: { ...f[key], ...patch } }));

  /** 保存高级设置：每类任务「选了服务商+模型」→ upsert；「全留空且原来有路由」→ 删除（恢复默认模型）。 */
  const saveAdvanced = async () => {
    setAdvancedSaving(true);
    try {
      for (const t of TASK_TYPES) {
        const f = formByTask[t.key];
        const provider = f.provider.trim();
        const model = f.model.trim();
        const temperature = f.temperature === "" ? null : num(f.temperature);
        const existing = routes.find((x) => x.task_type === t.key);
        if (provider && model) {
          await upsertRoute({ task_type: t.key, provider, model, temperature });
        } else if (existing) {
          await deleteRoute(existing.id);
        }
      }
      await load();
      setAdvancedOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAdvancedSaving(false);
    }
  };

  return (
    <Loading loading={loading || loadingModels}>
      <div className="grid w-full gap-6">
      {/* ---------- 模型接入：当前使用 + 服务商状态 + 添加/切换模型（弹窗） ---------- */}
      <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">模型接入</h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            点击「添加模型」，从自定义模型或预设服务商中选择，填 API Key 保存即用。未接入模型时 AI 功能不可用（页面顶部会有红色提示条）。Key 仅存本地，不回显明文。
          </p>
        </div>

        {/* 当前默认模型 */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2.5 dark:bg-zinc-900">
          <span className="text-xs text-zinc-500">当前使用：</span>
          <span className="rounded bg-zinc-900 px-2 py-0.5 font-mono text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
            {defaultModel ? `${defaultModel.provider}/${defaultModel.model}` : "未接入（AI 功能不可用）"}
          </span>
          {defaultModel && <span className="text-xs text-zinc-400">所有设定/蓝图/大纲/写作任务默认走它</span>}
        </div>

        {/* 服务商状态：已配置标绿，点击打开该服务商详情 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-400">服务商：</span>
          {catalog.length === 0 && <span className="text-xs text-zinc-400">加载中…</span>}
          {catalog.map((p) => (
            <button
              key={p.provider}
              onClick={() => openPicker(p.provider)}
              title={p.base_url}
              className={`rounded px-2 py-0.5 text-xs transition-colors ${
                p.enabledModels && p.enabledModels.length > 0
                  ? "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900 dark:text-green-300 dark:hover:bg-green-800"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              {p.label}
              {p.enabledModels && p.enabledModels.length > 0 ? `（${p.enabledModels.length}）` : ""}
            </button>
          ))}
        </div>

        <div>
          <button
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            onClick={() => openPicker()}
          >
            {defaultModel ? "切换模型 / 添加模型" : "添加模型"}
          </button>
        </div>
      </section>

      {/* ---------- 高级设置：按任务类型指定模型（按钮 + 弹窗配置） ---------- */}
      <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">高级设置：按任务类型指定模型</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              可选。不配置时全部任务用「模型接入」的默认模型；点「配置」在弹窗里为「设定 / 创作 / 评价 / 提取」四类任务分别指定模型后，对应任务优先用指定模型。
            </p>
          </div>
          <button
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={openAdvanced}
          >
            配置{loading ? "" : `（已指定 ${routes.length} 类）`}
          </button>
        </div>
        {loading ? (
          <p className="text-xs text-zinc-400">加载中…</p>
        ) : routes.length === 0 ? (
          <p className="text-xs text-zinc-400">尚未指定任何类型，所有任务都使用「模型接入」的默认模型。</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {routes.map((r) => {
              const t = TASK_TYPES.find((x) => x.key === r.task_type);
              return (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1 rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {t?.label ?? r.task_type}
                  <span className="font-mono">{r.provider}/{r.model}</span>
                </span>
              );
            })}
          </div>
        )}
      </section>

      {/* ---------- 添加模型弹窗 ---------- */}
      <ModelPickerModal
        open={pickerOpen}
        catalog={catalog}
        defaultModel={defaultModel}
        initialProvider={initialProvider}
        onClose={() => setPickerOpen(false)}
        onSaved={() => {
          loadModels();
          load(); // 同步刷新高级设置路由列表：移除模型时后端会联动删除对应路由
          refreshAiStatus(); // 同步全局 AI 就绪状态，让顶部红条立即消失
        }}
      />

      {/* ---------- 高级设置弹窗：四类任务分别指定模型 ---------- */}
      <Modal
        open={advancedOpen}
        title="高级设置：按任务类型指定模型"
        subtitle="四类任务可分别指定模型；留空表示该类型用「模型接入」的默认模型。保存后立即生效。"
        onClose={() => setAdvancedOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <>
            <button
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              onClick={() => setAdvancedOpen(false)}
            >
              取消
            </button>
            <button
              className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              onClick={saveAdvanced}
              disabled={advancedSaving}
            >
              {advancedSaving ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {TASK_TYPES.map((t) => {
            const f = formByTask[t.key];
            const ms = modelsFor(f.provider);
            return (
              <div key={t.key} className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t.label}</span>
                    <p className="text-[11px] text-zinc-400">{t.hint}</p>
                  </div>
                  <span className="shrink-0 rounded bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {f.provider && f.model ? `${f.provider}/${f.model}` : "默认模型"}
                  </span>
                </div>
                <div className="grid grid-cols-[1fr_1fr_110px] gap-2">
                  <select
                    className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
                    value={f.provider}
                    onChange={(e) => setTask(t.key, { provider: e.target.value, model: "" })}
                  >
                    <option value="">默认模型（不指定）</option>
                    {accessProviders.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
                    value={f.model}
                    onChange={(e) => setTask(t.key, { model: e.target.value })}
                    disabled={!f.provider}
                  >
                    <option value="">{f.provider ? "请选择模型" : "先选服务商"}</option>
                    {ms.map((m) => (
                      <option key={m.model} value={m.model}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    placeholder="温度 0.7"
                    className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
                    value={f.temperature}
                    onChange={(e) => setTask(t.key, { temperature: e.target.value })}
                  />
                </div>
              </div>
            );
          })}
          <p className="text-xs text-zinc-400">
            温度留空用默认 0.7；值越高回答越有创意、越不稳定，值越低越严谨稳定。全部留空则恢复为该类型的默认模型。
          </p>
        </div>
      </Modal>
      </div>
    </Loading>
  );
}
