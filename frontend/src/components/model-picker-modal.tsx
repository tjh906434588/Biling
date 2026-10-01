/**
 * @file model-picker-modal.tsx
 * 模型选择/配置弹窗：从自定义模型或预设服务商目录接入模型、测试连接、设为默认或移除。
 * 核心机制：三步视图（来源列表 → 服务商详情 / 自定义表单）；每个模型独立保存 API Key；
 * 点「添加」前自动探测连接（Key + 当前模型），成功才落库，可选同时设为默认并关闭弹窗。
 */
"use client";

import { useEffect, useState } from "react";
import {
  addAccessModel,
  probeProvider,
  refreshCatalogModels,
  removeAccessModel,
  saveCustomModel,
  setDefaultModel,
  type CatalogProvider,
  type DefaultModel,
} from "@/lib/api";
import { message } from "@/components/message";
import InfoTip from "./info-tip";

interface Props {
  open: boolean;
  defaultModel: DefaultModel | null;
  /** 打开时定位到指定服务商详情（页面服务商状态点进来） */
  initialProvider?: CatalogProvider | null;
  /** 打开时直接进自定义模型配置表单（页面点「自定义模型」入口） */
  initialCustom?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type View = "custom" | CatalogProvider;

/** 参考 TRAE「添加模型」弹窗：预设服务商详情 / 自定义模型表单（选模型→填Key→保存即用）。 */
export default function ModelPickerModal({ open, defaultModel, initialProvider, initialCustom, onClose, onSaved }: Props) {
  /** 当前所处视图：自定义表单 / 某个服务商详情 */
  const [view, setView] = useState<View>("custom");
  /** 当前选中（或手输）的模型 ID */
  const [modelId, setModelId] = useState("");
  /** 是否使用「其他模型」手输模式（不限于预置下拉列表） */
  const [useOther, setUseOther] = useState(false);
  const [apiKey, setApiKey] = useState("");
  /** 任一保存/探测/删除操作进行中，禁用按钮防重复提交 */
  const [busy, setBusy] = useState(false);
  const [probeModels, setProbeModels] = useState<string[] | null>(null);
  /** 当前服务商 Key 是否已通过「测试连接」，用于按钮状态展示。 */
  const [connected, setConnected] = useState(false);
  /** 服务商多配置方式（如火山方舟：ark-code-latest 自动 / model-name 指定模型名）当前选中的 key。 */
  const [configMode, setConfigMode] = useState<string | null>(null);
  /** 当前服务商已接入的模型清单（本地副本，添加/移除后即时更新）。 */
  const [enabled, setEnabled] = useState<{ model: string; label: string }[]>([]);
  /** 「刷新模型列表」结果覆盖：用有效 Key 从服务商拉到的账号真实模型，覆盖静态种子下拉（刷新后优先展示）。 */
  const [liveOverride, setLiveOverride] = useState<{ provider: string; models: { id: string; label: string }[]; updatedAt: string } | null>(null);

  // 自定义配置表单
  const [cust, setCust] = useState({
    label: "",
    api_format: "openai" as "openai" | "anthropic",
    base_url: "",
    model_id: "",
    api_key: "",
  });

  /** 进入某服务商详情：预选默认配置方式与首个模型，重置连接态为未连接。 */
  const openProvider = (p: CatalogProvider) => {
    setView(p);
    // 默认选中「Agent Plan 订阅（model-name）」配置方式（对应 TRAE 常用配法），无则取第一个
    const modes = p.config_modes ?? [];
    const defMode = modes.find((m) => m.key === "agent") ?? modes[0] ?? null;
    setConfigMode(defMode?.key ?? null);
    setModelId((defMode ? defMode.models : p.models)[0]?.id ?? "");
    setUseOther(false);
    setApiKey("");
    setProbeModels(null);
    setConnected(false);
    setEnabled(p.enabledModels ?? []);
    setLiveOverride(null);
  };

  useEffect(() => {
    if (open) {
      setProbeModels(null);
      if (initialCustom) {
        // 直接进自定义配置表单（页面「自定义模型」入口）：空表单起步
        setView("custom");
        setCust({ label: "", api_format: "openai", base_url: "", model_id: "", api_key: "" });
      } else if (initialProvider) {
        openProvider(initialProvider);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 弹窗打开期间监听 Esc 键关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // API Key 变了，之前的连接结果失效：撤销「已连接」并清掉探测结果/提示
  useEffect(() => {
    setConnected(false);
    setProbeModels(null);
  }, [apiKey]);

  /** 当前打开详情的服务商；custom 视图下为 null */
  const activeProvider: CatalogProvider | null = view !== "custom" ? view : null;

  // 多配置方式服务商（如火山方舟）：模型列表与 base_url 随所选配置方式联动
  const activeModes = activeProvider?.config_modes ?? null;
  const currentMode = activeModes ? (activeModes.find((m) => m.key === configMode) ?? activeModes[0]) : null;
  const modeModels =
    // 「刷新模型列表」结果优先：账号真实模型（任何服务商都生效；多配置方式服务商刷新的是当前配置方式的端点）
    liveOverride && activeProvider && liveOverride.provider === activeProvider.provider
      ? liveOverride.models
      : currentMode
        ? currentMode.models
        : (activeProvider?.models ?? []);
  const modeBaseUrl = currentMode ? currentMode.base_url : activeProvider?.base_url;

  /** 该模型是否当前默认模型（用于展示「默认」标记、隐藏「设为默认」按钮）。 */
  const isDefault = (model: string) =>
    defaultModel != null &&
    activeProvider != null &&
    defaultModel.provider === activeProvider.provider &&
    defaultModel.model === model;

  /** 探测连接（Key + 当前模型），返回是否成功；不管理 busy，由调用方负责。 */
  const runProbe = async (): Promise<boolean> => {
    if (!activeProvider) return false;
    setProbeModels(null);
    try {
      const models = await probeProvider(
        activeProvider.provider,
        apiKey.trim(),
        modeBaseUrl,
        modelId.trim() || undefined,
      );
      setProbeModels(models);
      setConnected(true);
      message.success(`连接成功，账号下可用 ${models.length} 个模型`);
      return true;
    } catch (e) {
      setConnected(false);
      message.error((e as Error).message);
      return false;
    }
  };

  /** 测试连接入口：校验 Key 非空后探测，期间锁住按钮防重复提交。 */
  const testConnect = async () => {
    if (!activeProvider || busy) return;
    if (!apiKey.trim()) {
      message.error("请先填写 API Key 再测试连接");
      return;
    }
    setBusy(true);
    await runProbe();
    setBusy(false);
  };

  /** 刷新模型列表：用 Key 从服务商拉取账号真实模型并缓存（替代静态种子目录），供本次选择与下次打开复用。 */
  const refreshList = async () => {
    if (!activeProvider || busy) return;
    if (!apiKey.trim()) {
      message.error("请先填写 API Key 再刷新模型列表");
      return;
    }
    setBusy(true);
    try {
      const r = await refreshCatalogModels(
        activeProvider.provider,
        apiKey.trim(),
        modeBaseUrl,
        modelId.trim() || undefined,
      );
      setLiveOverride({ provider: activeProvider.provider, models: r.models, updatedAt: r.updated_at });
      setModelId(r.models[0]?.id ?? "");
      setUseOther(false);
      setConnected(true);
      message.success(`已刷新：账号可用 ${r.models.length} 个模型（已缓存，下次打开自动使用）`);
      onSaved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 添加模型：每个模型独立填 Key 保存（各负责各，互不覆盖）；可同时设为默认。
   *
   * enableDefault=true 时同时设为默认并关闭弹窗；否则留在详情页，可继续添加同服务商的其他模型。
   */
  const addModel = async (enableDefault: boolean) => {
    if (!activeProvider) return;
    if (!modelId.trim()) {
      message.error("请选择或输入模型 ID");
      return;
    }
    if (!apiKey.trim()) {
      message.error("请填写该模型的 API Key（每个模型独立保存）");
      return;
    }
    setBusy(true);
    try {
      // 点「添加」自动先测试连接（Key + 当前模型），连接成功才保存
      const ok = await runProbe();
      if (!ok) return;
      await addAccessModel(
        activeProvider.provider,
        modelId.trim(),
        apiKey.trim(),
        modeBaseUrl,
        modeModels.find((m) => m.id === modelId.trim())?.label,
      );
      if (enableDefault) {
        await setDefaultModel(activeProvider.provider, modelId.trim());
      }
      const label = modeModels.find((m) => m.id === modelId.trim())?.label ?? modelId.trim();
      setEnabled((prev) =>
        prev.some((e) => e.model === modelId.trim()) ? prev : [...prev, { model: modelId.trim(), label }],
      );
      setApiKey("");
      message.success(enableDefault ? "已接入并设为默认，所有写作任务将使用该模型" : "已接入，可继续添加同服务商的其他模型");
      onSaved();
      if (enableDefault) onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 把清单里某个已接入模型设为默认。 */
  const setDefault = async (model: string) => {
    if (!activeProvider) return;
    setBusy(true);
    try {
      await setDefaultModel(activeProvider.provider, model);
      message.success("已切换为默认模型");
      onSaved();
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 从清单移除模型；移除的若是默认模型，后端会自动改用其他可用模型。 */
  const removeModel = async (model: string) => {
    if (!activeProvider) return;
    setBusy(true);
    try {
      await removeAccessModel(activeProvider.provider, model);
      setEnabled((prev) => prev.filter((e) => e.model !== model));
      message.success("已从接入清单移除");
      onSaved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 保存自定义配置：写入后直接设为默认模型。 */
  const saveCustom = async () => {
    if (!cust.label.trim() || !cust.base_url.trim() || !cust.model_id.trim() || !cust.api_key.trim()) {
      message.error("请完整填写展示名称、请求地址、模型 ID 和 API Key");
      return;
    }
    setBusy(true);
    try {
      const res = await saveCustomModel({
        label: cust.label.trim(),
        api_format: cust.api_format,
        base_url: cust.base_url.trim(),
        model_id: cust.model_id.trim(),
        api_key: cust.api_key.trim(),
      });
      await setDefaultModel(res.provider, res.model);
      onSaved();
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const inputCls =
    "mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900";
  const labelCls = "block text-xs text-zinc-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">添加模型</h2>
          <button
            className="rounded px-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* ---------- 视图一：自定义配置表单 ---------- */}
          {view === "custom" && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <label className={labelCls}>
                  模型展示名称
                  <input
                    className={inputCls}
                    placeholder="给模型起个名字，默认用模型 ID"
                    value={cust.label}
                    onChange={(e) => setCust({ ...cust, label: e.target.value })}
                  />
                </label>
                <label className={labelCls}>
                  API 格式
                  <select
                    className={inputCls}
                    value={cust.api_format}
                    onChange={(e) => setCust({ ...cust, api_format: e.target.value as "openai" | "anthropic" })}
                  >
                    <option value="openai">OpenAI Chat Completions</option>
                    <option value="anthropic">Anthropic Messages</option>
                  </select>
                </label>
              </div>
              <label className={labelCls}>
                请求地址（基础地址）
                <input
                  className={inputCls}
                  placeholder={cust.api_format === "openai" ? "https://api.xxx.com/v1" : "https://api.xxx.com"}
                  value={cust.base_url}
                  onChange={(e) => setCust({ ...cust, base_url: e.target.value })}
                />
                <span className="mt-0.5 block text-[11px] text-zinc-400">
                  {cust.api_format === "openai"
                    ? "填基础地址即可，系统会自动拼 /chat/completions"
                    : "填基础地址即可，系统会自动拼 /v1/messages"}
                </span>
              </label>
              <label className={labelCls}>
                模型 ID
                <input
                  className={inputCls}
                  placeholder="如 my-model-id"
                  value={cust.model_id}
                  onChange={(e) => setCust({ ...cust, model_id: e.target.value })}
                />
              </label>
              <label className={labelCls}>
                API Key
                <input
                  type="password"
                  className={inputCls}
                  placeholder="sk-…"
                  value={cust.api_key}
                  onChange={(e) => setCust({ ...cust, api_key: e.target.value })}
                />
              </label>
              <div className="mt-1 flex gap-2">
                <button
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  onClick={saveCustom}
                  disabled={busy}
                >
                  {busy ? "保存中…" : "保存并启用"}
                </button>
                <button
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  onClick={onClose}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* ---------- 视图三：服务商详情表单 ---------- */}
          {activeProvider && (
            <div className="flex flex-col gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{activeProvider.label}</h3>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    已接入 {enabled.length} 个模型
                  </span>
                  {/* 刷新模型列表：服务商模型会持续更新，用 Key 拉取账号真实模型并缓存，替代静态种子列表。
                      按钮 + 问号提示都放服务商名字右侧，不占独立一行。 */}
                  <button
                    className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 text-xs font-medium text-blue-700 transition-colors hover:border-blue-400 hover:bg-blue-100 disabled:opacity-50 disabled:hover:border-blue-300 disabled:hover:bg-blue-50 dark:border-blue-700 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:border-blue-500 dark:hover:bg-blue-900/60 dark:disabled:hover:border-blue-700 dark:disabled:hover:bg-blue-950/50"
                    onClick={refreshList}
                    disabled={busy || !apiKey.trim()}
                    title={
                      liveOverride && liveOverride.provider === activeProvider?.provider
                        ? `已按账号刷新（${liveOverride.updatedAt}）`
                        : undefined
                    }
                  >
                    <svg
                      className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                    {busy ? "刷新中…" : "刷新模型列表"}
                    <InfoTip>
                      服务商模型会更新，填 Key 后点刷新拉到你的账号真实模型并记住
                    </InfoTip>
                  </button>
                </div>
                {activeProvider.note && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{activeProvider.note}</p>}
              </div>

              {/* 已接入模型清单（一个 Key 可用同服务商多个模型） */}
              <div className="flex flex-col gap-1.5">
                <span className={labelCls}>已接入模型（{enabled.length}）</span>
                {enabled.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-xs leading-relaxed text-zinc-400 dark:border-zinc-700">
                    尚未接入任何模型。从下方选择一个模型，填入该模型的 API Key 点「添加」即可——每个模型独立保存自己的 Key，各负责各，互不影响。
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {enabled.map((e) => (
                      <div
                        key={e.model}
                        className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-sm">{e.model}</span>
                          {e.label && e.label !== e.model && (
                            <span className="block truncate text-[11px] text-zinc-400">{e.label}</span>
                          )}
                        </div>
                        {isDefault(e.model) ? (
                          <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600 dark:bg-blue-900 dark:text-blue-300">
                            默认
                          </span>
                        ) : (
                          <button
                            className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                            onClick={() => setDefault(e.model)}
                            disabled={busy}
                          >
                            设为默认
                          </button>
                        )}
                        <button
                          className="shrink-0 rounded border border-red-300 px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                          onClick={() => removeModel(e.model)}
                          disabled={busy}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 多配置方式服务商（如火山方舟）：先选配置方式，模型与地址跟着变 */}
              {activeModes && (
                <label className={labelCls}>
                  配置方式
                  <select
                    className={inputCls}
                    value={currentMode?.key ?? ""}
                    onChange={(e) => {
                      const k = e.target.value;
                      const m = activeModes.find((x) => x.key === k);
                      setConfigMode(k);
                      setModelId(m?.models[0]?.id ?? "");
                      setUseOther(false);
                      setProbeModels(null);
                      setConnected(false);
                      // 配置方式切换 = 换端点：上次刷新的模型列表是旧端点的，不复用，等重新刷新
                      setLiveOverride(null);
                    }}
                  >
                    {activeModes.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-0.5 block text-[11px] text-zinc-400">
                    {currentMode?.hint ?? "选择该配置方式下的模型"}
                  </span>
                </label>
              )}

              {/* 添加模型（预置列表 / 使用其他模型） */}
              <label className={labelCls}>
                添加模型
                {!useOther ? (
                  <select className={inputCls} value={modelId} onChange={(e) => setModelId(e.target.value)}>
                    {modeModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={inputCls}
                    placeholder="输入模型 ID"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  />
                )}
                <span
                  className="mt-1 inline-block cursor-pointer text-[11px] text-blue-500 underline hover:text-blue-600"
                  onClick={() => {
                    setUseOther(!useOther);
                    setModelId(!useOther ? "" : modeModels[0]?.id ?? "");
                  }}
                >
                  {useOther ? "使用预置模型" : "使用其他模型"}
                </span>
              </label>

              <label className={labelCls}>
                API Key
                <input
                  type="password"
                  className={inputCls}
                  placeholder="输入该模型的 API Key（独立保存）"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>
              <div className="flex items-center justify-between">
                {activeProvider.key_url ? (
                  <a
                    href={activeProvider.key_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-500 underline hover:text-blue-600"
                  >
                    获取 Key ↗
                  </a>
                ) : (
                  <span />
                )}
                <span className="text-[11px] text-zinc-400">Key 仅存本地，不回显</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  onClick={() => addModel(true)}
                  disabled={busy}
                >
                  {busy ? "保存中…" : "添加并设为默认"}
                </button>
                <button
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  onClick={() => addModel(false)}
                  disabled={busy}
                >
                  添加
                </button>
                <button
                  className={
                    connected
                      ? "rounded-lg border border-green-500 bg-green-50 px-4 py-2 text-sm text-green-700 hover:bg-green-100 disabled:opacity-50 dark:border-green-700 dark:bg-green-950/40 dark:text-green-300"
                      : "rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  }
                  onClick={testConnect}
                  disabled={busy || !apiKey.trim()}
                >
                  {connected ? "✓ 已连接" : "测试连接"}
                </button>
              </div>
              {!connected && apiKey.trim() && (
                <p className="text-[11px] text-zinc-400">点「添加」会自动测试连接，通过后即保存</p>
              )}

              {probeModels && probeModels.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-zinc-400">账号可用模型：</span>
                  {probeModels.map((m) => (
                    <span
                      key={m}
                      className="cursor-pointer rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-600 hover:bg-blue-100 dark:bg-zinc-800 dark:text-zinc-300"
                      onClick={() => {
                        setModelId(m);
                        setUseOther(true);
                      }}
                    >
                      {m}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
