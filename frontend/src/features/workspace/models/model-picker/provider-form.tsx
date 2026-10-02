/**
 * @file components/model-picker/provider-form.tsx
 * 服务商详情配置表单（由 model-picker-modal.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——服务商 provider、已接入清单（EnabledList 子组件）、
 * 配置方式切换 onModeChange、添加模型（下拉/手输 + 密钥）、检查/添加按钮与探测结果 chips 的
 * 数据与回调全部由父组件下发，父组件保留全部状态、派生值与请求逻辑。
 */
"use client";

import type { Dispatch, SetStateAction } from "react";
import type { CatalogModel, CatalogProvider } from "@/lib/api";
import InfoTip from "@/components/info-tip";
import EnabledList from "./enabled-list";
import { inputCls, labelCls, type ConfigMode, type EnabledModel, type LiveOverride } from "./utils";

interface Props {
  /** 当前打开详情的服务商 */
  provider: CatalogProvider;
  /** 当前服务商已接入的模型清单（本地副本，添加/移除后即时更新） */
  enabled: EnabledModel[];
  /** 任一保存/探测/删除操作进行中，禁用按钮防重复提交 */
  busy: boolean;
  /** 该模型是否当前默认模型（展示「当前在用」标记、隐藏「设为默认」按钮） */
  isDefault: (model: string) => boolean;
  /** 把清单里某个已接入模型设为默认（父组件执行后自动关闭弹窗） */
  onSetDefault: (model: string) => void;
  /** 请求移除某个已接入模型（父组件弹二次确认后执行） */
  onRemove: (model: string, label: string) => void;
  /** 多配置方式服务商（如火山方舟）的全部配置方式；null = 无多配置 */
  modes: ConfigMode[] | null;
  /** 当前选中的配置方式条目（无匹配时回退第一个） */
  currentMode: ConfigMode | null;
  /** 切换配置方式：父组件联动重置模型列表/连接态等 */
  onModeChange: (key: string) => void;
  /** 当前生效的候选模型列表（刷新结果优先，其次当前配置方式，最后静态种子） */
  modeModels: CatalogModel[];
  modelId: string;
  setModelId: Dispatch<SetStateAction<string>>;
  /** 是否使用「其他模型」手输模式（不限于预置下拉列表） */
  useOther: boolean;
  /** 切换手输模式（父组件联动重置模型编号） */
  onToggleUseOther: () => void;
  apiKey: string;
  setApiKey: Dispatch<SetStateAction<string>>;
  /** 刷新模型列表（用 Key 拉取账号真实模型并缓存，替代静态种子目录） */
  onRefresh: () => void;
  /** 是否正在「刷新模型列表」（独立于 busy：刷新按钮单独显示「更新中…」） */
  refreshing: boolean;
  /** 「刷新模型列表」结果覆盖（用于按钮 title 提示上次更新时间） */
  liveOverride: LiveOverride | null;
  /** 测试连接（校验 Key 后探测，期间锁住按钮防重复提交） */
  onTestConnect: () => void;
  /** 当前服务商 Key 是否已通过「测试连接」 */
  connected: boolean;
  /** 当前点击的是哪个按钮（默认/仅添加）：只有被点击的按钮显示「保存中…」 */
  savingWhich: "default" | "plain" | null;
  /** 添加并设为默认用（成功后关闭弹窗） */
  onAddDefault: () => void;
  /** 仅添加（成功后留在详情页，可继续添加同服务商的其他模型） */
  onAddPlain: () => void;
  /** 探测到的账号可用模型；null = 尚未探测/探测失败 */
  probeModels: string[] | null;
  /** 点探测结果里的某个模型：直接选用并切到手输模式 */
  onPickProbe: (model: string) => void;
}

/** 服务商详情表单：标题 + 更新按钮 → 已接入清单 → 配置方式 → 添加模型 → 密钥 → 检查/添加按钮 → 探测结果。 */
export default function ProviderForm({
  provider,
  enabled,
  busy,
  isDefault,
  onSetDefault,
  onRemove,
  modes,
  currentMode,
  onModeChange,
  modeModels,
  modelId,
  setModelId,
  useOther,
  onToggleUseOther,
  apiKey,
  setApiKey,
  onRefresh,
  refreshing,
  liveOverride,
  onTestConnect,
  connected,
  savingWhich,
  onAddDefault,
  onAddPlain,
  probeModels,
  onPickProbe,
}: Props) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{provider.label}</h3>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            已添加 {enabled.length} 个模型
          </span>
          {/* 刷新模型列表：服务商模型会持续更新，用 Key 拉取账号真实模型并缓存，替代静态种子列表。
              按钮 + 问号提示都放服务商名字右侧，不占独立一行。 */}
          <button
            className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 text-xs font-medium text-blue-700 transition-colors hover:border-blue-400 hover:bg-blue-100 disabled:opacity-50 disabled:hover:border-blue-300 disabled:hover:bg-blue-50 dark:border-blue-700 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:border-blue-500 dark:hover:bg-blue-900/60 dark:disabled:hover:border-blue-700 dark:disabled:hover:bg-blue-950/50"
            onClick={onRefresh}
            disabled={busy || refreshing || !apiKey.trim()}
            title={
              liveOverride && liveOverride.provider === provider.provider
                ? `已按账号更新（${liveOverride.updatedAt}）`
                : undefined
            }
          >
            <svg
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
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
            {refreshing ? "更新中…" : "更新模型列表"}
            <InfoTip>
              AI 服务公司会不断上架新模型，填好密钥后点这里，把你账号里真实能用的模型拉下来并记住。
            </InfoTip>
          </button>
        </div>
        {provider.note && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{provider.note}</p>}
      </div>

      {/* 已接入模型清单（一个 Key 可用同服务商多个模型） */}
      <EnabledList enabled={enabled} busy={busy} isDefault={isDefault} onSetDefault={onSetDefault} onRemove={onRemove} />

      {/* 多配置方式服务商（如火山方舟）：先选配置方式，模型与地址跟着变 */}
      {modes && (
        <label className={labelCls}>
          接入方式
          <select
            className={inputCls}
            value={currentMode?.key ?? ""}
            onChange={(e) => onModeChange(e.target.value)}
          >
            {modes.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="mt-0.5 block text-[11px] text-zinc-400">
            {currentMode?.hint ?? "选这个接入方式对应的模型"}
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
            placeholder="输入模型编号"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          />
        )}
        <span
          className="mt-1 inline-block cursor-pointer text-[11px] text-blue-500 underline hover:text-blue-600"
          onClick={onToggleUseOther}
        >
          {useOther ? "用列表里的模型" : "自己输入其他模型"}
        </span>
      </label>

      <label className={labelCls}>
        密钥
        <input
          type="password"
          className={inputCls}
          placeholder="输入这个模型的密钥（各存各的）"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        {provider.key_url ? (
          <div className="flex min-w-0 items-center gap-2">
            <a
              href={provider.key_url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs text-blue-500 underline hover:text-blue-600"
            >
              去获取密钥 ↗
            </a>
            {!connected && apiKey.trim() && (
              <span className="truncate text-[11px] text-zinc-400">
                点「添加」后会自动检查密钥是否正确，检查通过就保存。
              </span>
            )}
          </div>
        ) : (
          <span />
        )}
        <span className="shrink-0 text-[11px] text-zinc-400">密钥只存在你电脑里，不会显示出来</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          onClick={onAddDefault}
          disabled={busy}
        >
          {savingWhich === "default" ? "保存中…" : "添加并设为默认用"}
        </button>
        <button
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          onClick={onAddPlain}
          disabled={busy}
        >
          {savingWhich === "plain" ? "保存中…" : "添加"}
        </button>
        <button
          className={
            connected
              ? "rounded-lg border border-green-500 bg-green-50 px-4 py-2 text-sm text-green-700 hover:bg-green-100 disabled:opacity-50 dark:border-green-700 dark:bg-green-950/40 dark:text-green-300"
              : "rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          }
          onClick={onTestConnect}
          disabled={busy || !apiKey.trim()}
        >
          {connected ? "✓ 检查通过" : "检查密钥"}
        </button>
      </div>

      {probeModels && probeModels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-zinc-400">账号可用模型：</span>
          {probeModels.map((m) => (
            <span
              key={m}
              className="cursor-pointer rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-600 hover:bg-blue-100 dark:bg-zinc-800 dark:text-zinc-300"
              onClick={() => onPickProbe(m)}
            >
              {m}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
