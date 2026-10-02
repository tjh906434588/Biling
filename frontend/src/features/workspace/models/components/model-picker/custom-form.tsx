/**
 * @file components/model-picker/custom-form.tsx
 * 「自定义模型配置」表单（由 model-picker-modal.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——表单状态 cust/setCust、保存忙碌态 busy、
 * 保存动作 onSave 与取消 onClose 均由父组件下发；样式类 inputCls/labelCls 取自同目录 utils。
 */
"use client";

import type { Dispatch, SetStateAction } from "react";
import { inputCls, labelCls, type CustState } from "./utils";

interface Props {
  cust: CustState;
  setCust: Dispatch<SetStateAction<CustState>>;
  /** 保存进行中，禁用按钮防重复提交 */
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
}

/** 自定义模型表单：模型名称 / 接口类型 / 连接地址 / 模型编号 / 密钥 + 保存按钮。 */
export default function CustomForm({ cust, setCust, busy, onSave, onClose }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          模型名称（自己起个名）
          <input
            className={inputCls}
            placeholder="给模型起个名字（不填就用模型编号）"
            value={cust.label}
            onChange={(e) => setCust({ ...cust, label: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          接口类型
          <select
            className={inputCls}
            value={cust.api_format}
            onChange={(e) => setCust({ ...cust, api_format: e.target.value as "openai" | "anthropic" })}
          >
            <option value="openai">OpenAI Chat Completions</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
          <span className="mt-0.5 block text-[11px] text-zinc-400">一般选第一个；不确定就保持默认</span>
        </label>
      </div>
      <label className={labelCls}>
        连接地址（服务器地址）
        <input
          className={inputCls}
          placeholder={cust.api_format === "openai" ? "https://api.xxx.com/v1" : "https://api.xxx.com"}
          value={cust.base_url}
          onChange={(e) => setCust({ ...cust, base_url: e.target.value })}
        />
        <span className="mt-0.5 block text-[11px] text-zinc-400">
          {cust.api_format === "openai"
            ? "填服务器地址就行，剩下的系统会自动补齐"
            : "填服务器地址就行，剩下的系统会自动补齐"}
        </span>
      </label>
      <label className={labelCls}>
        模型编号
        <input
          className={inputCls}
          placeholder="如 my-model-id"
          value={cust.model_id}
          onChange={(e) => setCust({ ...cust, model_id: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        密钥（API Key）
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
          onClick={onSave}
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
  );
}
