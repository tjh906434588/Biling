/**
 * @file models-panel.tsx
 * 模型管理面板：展示当前默认模型与服务商接入状态，提供添加/切换模型（弹窗）入口；
 * 高级设置可为「设定/创作/评价/提取」四类任务分别指定模型。
 * 核心机制：任务路由（ModelRoute）按任务类型映射服务商+模型+温度，留空即回退默认模型；
 * 保存后同步刷新路由列表与全局 AI 就绪状态（顶部红条即时消失）。
 */
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
import Modal from "@/components/modal";
import ModelPickerModal from "./components/model-picker-modal";
import Loading from "@/components/loading";
import { useAiStatus } from "@/lib/ai-status";
import { message } from "@/components/message";
import { TASK_TYPES, type TaskType } from "@/constants/task-types";

/** 各任务类型各自的配置表单（provider/model/temperature；留空 = 用默认模型） */
type TaskForm = Record<TaskType, { provider: string; model: string; temperature: string }>;
const EMPTY_TASK_FORMS: TaskForm = {
  setting: { provider: "", model: "", temperature: "" },
  check: { provider: "", model: "", temperature: "" },
  planning: { provider: "", model: "", temperature: "" },
  creation: { provider: "", model: "", temperature: "" },
  extract: { provider: "", model: "", temperature: "" },
  review: { provider: "", model: "", temperature: "" },
  chronicle: { provider: "", model: "", temperature: "" },
};

export default function ModelsPanel() {
  const { refresh: refreshAiStatus } = useAiStatus();
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [loading, setLoading] = useState(true);
  // 模型目录 / 默认模型加载中：遮罩过渡，加载完成后解除
  const [loadingModels, setLoadingModels] = useState(true);
  // ---- 高级设置弹窗：五类任务各自配置 ----
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [formByTask, setFormByTask] = useState<TaskForm>(EMPTY_TASK_FORMS);

  // ---- 模型接入：弹窗驱动（参考 TRAE「添加模型」：自定义模型置顶 + 预设服务商） ----
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [defaultModel, setDefaultModelState] = useState<DefaultModel | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 从页面服务商状态点进来时记录的目标服务商名，弹窗据此定位到其详情 */
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  /** 打开弹窗是否直接进自定义模型配置表单（点「自定义模型」服务商入口时） */
  const [pickerCustom, setPickerCustom] = useState(false);

  /** 拉取任务路由列表（高级设置当前配置现状）。 */
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

  /** 并行拉取模型目录与默认模型（服务商状态徽标与弹窗的数据源）。 */
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

  /** 打开添加模型弹窗；传入 provider 时定位到该服务商详情；custom=true 直接进自定义配置表单。 */
  const openPicker = (provider?: string, custom = false) => {
    setPendingProvider(custom ? null : (provider ?? null));
    setPickerCustom(custom);
    setPickerOpen(true);
  };

  /** 页面服务商状态点进来时，定位到该服务商详情。 */
  const initialProvider = useMemo(
    () => (pendingProvider ? catalog.find((p) => p.provider === pendingProvider) ?? null : null),
    [pendingProvider, catalog],
  );

  /** 温度容错解析：空串/非法输入返回 null（表示用默认值）。 */
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
    key: TaskType,
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
      message.success("高级设置已保存");
      setAdvancedOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAdvancedSaving(false);
    }
  };

  return (
    <Loading loading={loading || loadingModels}>
      <div className="grid w-full gap-4">
      {/* ---------- 模型接入：当前使用 + 服务商状态 + 添加/切换模型（弹窗） ---------- */}
      <section className="panel flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">AI 模型设置</h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            在下方选一家 AI 服务（或点最后的「自定义模型」），选好模型、填上密钥保存就能用。没配好模型时 AI 功能暂时用不了（页面顶部会有红色提示条）。密钥只存在你电脑里，不会显示出来。
          </p>
        </div>

        {/* 当前默认模型 */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2.5 dark:bg-zinc-900">
          <span className="text-xs text-zinc-500">当前使用：</span>
          <span className="rounded bg-zinc-900 px-2 py-0.5 font-mono text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
            {defaultModel
              ? `${catalog.find((p) => p.provider === defaultModel.provider)?.label ?? defaultModel.provider} · ${defaultModel.model}`
              : "未配置模型（AI 功能不可用）"}
          </span>
          {defaultModel && <span className="text-xs text-zinc-400">设定、蓝图、大纲、写作这些功能默认都用它</span>}
        </div>

        {/* 服务商状态：已配置标绿，点击打开该服务商详情 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-400">AI 服务：</span>
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
          {/* 自定义模型：接入未预设的模型 / 中转站，放在服务商列表最后 */}
          <button
            onClick={() => openPicker(undefined, true)}
            className="rounded border border-dashed border-blue-300 px-2 py-0.5 text-xs text-blue-600 transition-colors hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/40"
          >
            + 自定义模型
          </button>
        </div>
      </section>

      {/* ---------- 高级设置：按任务类型指定模型（按钮 + 弹窗配置） ---------- */}
      <section className="panel flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">高级设置：为不同写作环节选不同的模型</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              可不用。不设置时所有环节都用前面配好的默认模型。点「设置」可以给设定、创作、提取、编年、评价五种写作环节分别选模型。
            </p>
          </div>
          <button
            className="btn btn-ghost"
            onClick={openAdvanced}
          >
            设置{loading ? "" : `（已设置 ${routes.length} 项）`}
          </button>
        </div>
        {loading ? (
          <p className="text-xs text-zinc-400">加载中…</p>
        ) : routes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-5 text-center text-xs leading-6 text-zinc-400 dark:border-zinc-700">
            还没做设置，所有写作环节都用前面配好的默认模型。
          </div>
        ) : (
          /* 四类任务逐行展示：任务名 + 用途说明在左，右侧显示该类型当前用的模型（已指定/默认模型） */
          <div className="flex flex-col divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {TASK_TYPES.map((t) => {
              const r = routes.find((x) => x.task_type === t.key);
              const providerLabel = r ? catalog.find((p) => p.provider === r.provider)?.label ?? r.provider : null;
              return (
                <div key={t.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t.label}</span>
                    <span className="ml-2 text-[11px] text-zinc-400">{t.hint}</span>
                  </div>
                  <span
                    className={`shrink-0 rounded px-2 py-0.5 font-mono text-[11px] ${
                      r
                        ? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                        : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
                    }`}
                  >
                    {r ? `${providerLabel}/${r.model}` : "默认模型"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ---------- 添加模型弹窗 ---------- */}
      <ModelPickerModal
        open={pickerOpen}
        defaultModel={defaultModel}
        initialProvider={initialProvider}
        initialCustom={pickerCustom}
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
        title="高级设置：为不同写作环节选不同的模型"
        subtitle="可以给每种写作环节分别选模型；不选就用前面配好的默认模型。保存后立即生效。"
        onClose={() => setAdvancedOpen(false)}
        maxWidth="max-w-2xl"
        footer={
          <>
            <button
              className="btn btn-ghost px-3 py-1.5"
              onClick={() => setAdvancedOpen(false)}
            >
              取消
            </button>
            <button
              className="btn btn-primary px-4 py-1.5"
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
                    {f.provider && f.model
                      ? `${catalog.find((p) => p.provider === f.provider)?.label ?? f.provider}/${f.model}`
                      : "默认模型"}
                  </span>
                </div>
                <div className="grid grid-cols-[1fr_1fr_110px] gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-zinc-400">AI 服务</span>
                    <select
                      className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
                      value={f.provider}
                      onChange={(e) => setTask(t.key, { provider: e.target.value, model: "" })}
                    >
                      <option value="">用默认模型（不单独指定）</option>
                      {accessProviders.map((p) => (
                        <option key={p.provider} value={p.provider}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-zinc-400">模型</span>
                    <select
                      className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
                      value={f.model}
                      onChange={(e) => setTask(t.key, { model: e.target.value })}
                      disabled={!f.provider}
                    >
                      <option value="">{f.provider ? "请选择模型" : "先选 AI 服务"}</option>
                      {ms.map((m) => (
                        <option key={m.model} value={m.model}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-zinc-400">创意程度（温度）</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      placeholder="0.7"
                      className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
                      value={f.temperature}
                      onChange={(e) => setTask(t.key, { temperature: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            );
          })}
          <p className="text-xs text-zinc-400">
            温度留空用默认 0.7；值越高回答越有创意、越不稳定，值越低越严谨稳定。都留空就用默认模型。
          </p>
        </div>
      </Modal>
      </div>
    </Loading>
  );
}
