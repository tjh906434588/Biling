/**
 * @file model-picker-modal.tsx
 * 模型选择/配置弹窗：从自定义模型或预设服务商目录接入模型、测试连接、设为默认或移除。
 * 核心机制：三步视图（来源列表 → 服务商详情 / 自定义表单）；每个模型独立保存 API Key；
 * 点「添加」前自动探测连接（Key + 当前模型），成功才落库，可选同时设为默认并关闭弹窗。
 * 展示层已按逻辑边界拆分到 model-picker/：自定义表单 custom-form、服务商详情 provider-form
 * （含已接入清单 enabled-list）、纯函数与类型 utils；本文件只保留状态、派生值与数据加载/提交逻辑。
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
import ConfirmDialog from "@/components/confirm-dialog";
import CustomForm from "./model-picker/custom-form";
import ProviderForm from "./model-picker/provider-form";
import {
  isDefaultModel,
  type CustState,
  type EnabledModel,
  type LiveOverride,
  type View,
} from "./model-picker/utils";

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
  /** 当前点击的是哪个按钮（默认/仅添加）：只有被点击的按钮显示「保存中…」，另一个保持原文案 */
  const [savingWhich, setSavingWhich] = useState<"default" | "plain" | null>(null);
  /** 是否正在「刷新模型列表」（独立于 busy：点添加/测试连接不该让刷新按钮变「刷新中」） */
  const [refreshing, setRefreshing] = useState(false);
  const [probeModels, setProbeModels] = useState<string[] | null>(null);
  /** 当前服务商 Key 是否已通过「测试连接」，用于按钮状态展示。 */
  const [connected, setConnected] = useState(false);
  /** 服务商多配置方式（如火山方舟：ark-code-latest 自动 / model-name 指定模型名）当前选中的 key。 */
  const [configMode, setConfigMode] = useState<string | null>(null);
  /** 当前服务商已接入的模型清单（本地副本，添加/移除后即时更新）。 */
  const [enabled, setEnabled] = useState<EnabledModel[]>([]);
  /** 待移除确认的模型（非 null 时弹出二次确认弹窗）。 */
  const [pendingRemove, setPendingRemove] = useState<EnabledModel | null>(null);
  /** 「刷新模型列表」结果覆盖：用有效 Key 从服务商拉到的账号真实模型，覆盖静态种子下拉（刷新后优先展示）。 */
  const [liveOverride, setLiveOverride] = useState<LiveOverride | null>(null);

  // 自定义配置表单
  const [cust, setCust] = useState<CustState>({
    label: "",
    api_format: "openai",
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

  // 父级 catalog 刷新（添加/移除后 onSaved 触发 loadModels）后，initialProvider 变成新对象
  // （enabledModels 为后端最新）：弹窗正定位到该服务商时，用后端数据同步本地已接入列表，
  // 保证「已接入模型」立即反映最新状态（不能只靠添加/移除时的本地 setEnabled）。
  useEffect(() => {
    if (!open || !initialProvider) return;
    if (view !== "custom" && view.provider === initialProvider.provider) {
      setEnabled(initialProvider.enabledModels ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProvider, open]);

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

  /** 该模型是否当前默认模型（用于展示「当前在用」标记、隐藏「设为默认」按钮）。 */
  const isDefault = (model: string) => isDefaultModel(defaultModel, activeProvider, model);

  /** 切换服务商多配置方式（如火山方舟）：模型列表与 base_url 随所选配置方式联动。 */
  const changeMode = (key: string) => {
    if (!activeModes) return;
    const m = activeModes.find((x) => x.key === key);
    setConfigMode(key);
    setModelId(m?.models[0]?.id ?? "");
    setUseOther(false);
    setProbeModels(null);
    setConnected(false);
    // 配置方式切换 = 换端点：上次刷新的模型列表是旧端点的，不复用，等重新刷新
    setLiveOverride(null);
  };

  /** 「使用其他模型」开关：切换手输模式，同时重置模型编号为列表首个或清空。 */
  const toggleUseOther = () => {
    setUseOther(!useOther);
    setModelId(!useOther ? "" : modeModels[0]?.id ?? "");
  };

  /** 点探测结果里的某个模型：直接选用并切到手输模式。 */
  const pickProbe = (model: string) => {
    setModelId(model);
    setUseOther(true);
  };

  /** 探测连接（Key + 当前模型），返回是否成功；不管理 busy，由调用方负责。
   *  silent=true 时不弹成功提示（添加流程里探测只是前置校验，成功提示由添加自己的 message 承担，避免双提示）。 */
  const runProbe = async (silent = false): Promise<boolean> => {
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
      if (!silent) {
        message.success(`检查通过，账号下可用 ${models.length} 个模型`);
      }
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
      message.error("请先填写密钥，再点「检查密钥」");
      return;
    }
    setBusy(true);
    await runProbe();
    setBusy(false);
  };

  /** 刷新模型列表：用 Key 从服务商拉取账号真实模型并缓存（替代静态种子目录），供本次选择与下次打开复用。 */
  const refreshList = async () => {
    if (!activeProvider || busy || refreshing) return;
    if (!apiKey.trim()) {
      message.error("请先填写密钥，再更新模型列表");
      return;
    }
    setRefreshing(true);
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
      message.success(`已更新：账号可用 ${r.models.length} 个模型（已记住，下次打开自动使用）`);
      onSaved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  /** 添加模型：每个模型独立填 Key 保存（各负责各，互不覆盖）；可同时设为默认。
   *
   * enableDefault=true 时同时设为默认并关闭弹窗；否则留在详情页，可继续添加同服务商的其他模型。
   */
  const addModel = async (enableDefault: boolean) => {
    if (!activeProvider) return;
    if (!modelId.trim()) {
      message.error("请选择或输入模型编号");
      return;
    }
    if (!apiKey.trim()) {
      message.error("请填写这个模型的密钥（每个模型各存各的）");
      return;
    }
    setBusy(true);
    setSavingWhich(enableDefault ? "default" : "plain");
    try {
      // 点「添加」自动先测试连接（Key + 当前模型），连接成功才保存；
      // 探测静默（silent=true）：成功提示由下方「已接入」一条承担，避免双提示
      const ok = await runProbe(true);
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
      message.success(enableDefault ? "已添加并设为默认用，所有写作任务都会用它" : "已添加，可继续添加同服务商的其他模型");
      onSaved();
      // 添加成功不自动关闭弹窗：用户可能还要继续添加其他模型，关闭由用户手动进行（Esc / ✕）
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
      setSavingWhich(null); // 恢复被点按钮的文案（否则一直停留在「保存中…」）
    }
  };

  /** 把清单里某个已接入模型设为默认。 */
  const setDefault = async (model: string) => {
    if (!activeProvider) return;
    setBusy(true);
    try {
      await setDefaultModel(activeProvider.provider, model);
      message.success("已切换为默认用的模型");
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
      message.success("已从清单移除");
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
      message.error("请完整填写模型名称、连接地址、模型编号和密钥");
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
            <CustomForm cust={cust} setCust={setCust} busy={busy} onSave={saveCustom} onClose={onClose} />
          )}

          {/* ---------- 视图三：服务商详情表单 ---------- */}
          {activeProvider && (
            <ProviderForm
              provider={activeProvider}
              enabled={enabled}
              busy={busy}
              isDefault={isDefault}
              onSetDefault={setDefault}
              onRemove={(model, label) => setPendingRemove({ model, label })}
              modes={activeModes}
              currentMode={currentMode}
              onModeChange={changeMode}
              modeModels={modeModels}
              modelId={modelId}
              setModelId={setModelId}
              useOther={useOther}
              onToggleUseOther={toggleUseOther}
              apiKey={apiKey}
              setApiKey={setApiKey}
              onRefresh={refreshList}
              refreshing={refreshing}
              liveOverride={liveOverride}
              onTestConnect={testConnect}
              connected={connected}
              savingWhich={savingWhich}
              onAddDefault={() => addModel(true)}
              onAddPlain={() => addModel(false)}
              probeModels={probeModels}
              onPickProbe={pickProbe}
            />
          )}
        </div>
      </div>

      {/* 移除模型二次确认 */}
      <ConfirmDialog
        open={pendingRemove != null}
        title="移除模型"
        message={`确定要把「${pendingRemove?.label ?? ""}」移除吗？\n移除后就不能再用它了；如果它现在是默认用的模型，系统会自动改用其他可用模型。`}
        confirmText="移除"
        cancelText="取消"
        onConfirm={() => {
          const target = pendingRemove?.model;
          setPendingRemove(null);
          if (target) void removeModel(target);
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
