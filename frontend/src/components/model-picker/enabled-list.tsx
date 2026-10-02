/**
 * @file components/model-picker/enabled-list.tsx
 * 服务商详情里的「已接入模型清单」（由 model-picker-modal.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——清单数据 enabled、忙碌态 busy、默认判定 isDefault、
 * 设为默认 onSetDefault / 移除 onRemove（父组件弹二次确认）均由父组件下发。
 */
"use client";

import { labelCls, type EnabledModel } from "./utils";

interface Props {
  /** 当前服务商已接入的模型清单（本地副本，父组件在添加/移除后即时更新） */
  enabled: EnabledModel[];
  /** 任一保存/移除操作进行中，禁用按钮防重复提交 */
  busy: boolean;
  /** 该模型是否当前默认模型（展示「当前在用」标记、隐藏「设为默认」按钮） */
  isDefault: (model: string) => boolean;
  /** 把某个已接入模型设为默认 */
  onSetDefault: (model: string) => void;
  /** 请求移除某个模型：父组件弹二次确认后执行 */
  onRemove: (model: string, label: string) => void;
}

/** 已接入模型清单：空态提示 / 每行（模型编号 + 名称 + 默认标记或「设为默认」+ 移除）。 */
export default function EnabledList({ enabled, busy, isDefault, onSetDefault, onRemove }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={labelCls}>已添加的模型（{enabled.length}）</span>
      {enabled.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-xs leading-relaxed text-zinc-400 dark:border-zinc-700">
          还没添加任何模型。从下面选一个，填上它的密钥点「添加」就行——每个模型各存各的密钥，互不影响。
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
                  当前在用
                </span>
              ) : (
                <button
                  className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  onClick={() => onSetDefault(e.model)}
                  disabled={busy}
                >
                  设为默认用
                </button>
              )}
              <button
                className="shrink-0 rounded border border-red-300 px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                onClick={() => onRemove(e.model, e.label || e.model)}
                disabled={busy}
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
