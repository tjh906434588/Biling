/**
 * @file components/settings/setting-form.tsx
 * 「新增/编辑设定」弹窗（由 settings-panel.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——表单状态 form / setForm、正在编辑的设定 editing、
 * 保存忙碌态 busy、出现时机所需的阶段计划 stagePlan 与保存动作均由父组件下发。
 * 表单字段按类型动态展示（角色等级、背景机构勾选），底部含「不可变/可变」两栏与出现时机控件。
 */
"use client";

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import Modal from "@/components/modal";
import InfoTip from "@/components/info-tip";
import { TimingBlock, type StagePlan } from "./timing";
import type { FormState } from "./settings-utils";
import {
  SETTING_TYPES,
  loadRoleRanks,
  loadSettingTypes,
  type RoleRankOption,
  type SettingSpec,
} from "@/constants";
import type { Setting, SettingType } from "@/lib/api";

interface Props {
  open: boolean;
  /** 正在编辑的设定；null = 新增模式（类型不可改）。 */
  editing: Setting | null;
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  busy: boolean;
  stagePlan: StagePlan;
  onSave: () => void;
  onClose: () => void;
}

/** 「新增/编辑设定」弹窗：表单分「不可变（AI 永不违背）/ 可变（随剧情演变）」两栏。 */
export default function SettingFormModal({
  open,
  editing,
  form,
  setForm,
  busy,
  stagePlan,
  onSave,
  onClose,
}: Props) {
  /** 设定类型规格 / 角色等级（枚举字典，后端单一源；拉取前类型提示为空、下拉只剩 key）。 */
  const [settingTypes, setSettingTypes] = useState<SettingSpec[]>([]);
  const [roleRanks, setRoleRanks] = useState<RoleRankOption[]>([]);
  useEffect(() => {
    void loadSettingTypes().then(setSettingTypes);
    void loadRoleRanks().then(setRoleRanks);
  }, []);
  const specOf = (t: SettingType) => settingTypes.find((s) => s.key === t) ?? null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "编辑设定" : "新增设定"}
      subtitle="「不可变」栏 AI 永不违背，其余随剧情演变；先写主角一条就能开笔，边写边补。"
      maxWidth="max-w-xl"
      fullHeight
      footer={
        <>
          <button type="button" className="btn btn-ghost px-4 py-1.5 text-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary px-4 py-1.5 text-sm" onClick={onSave} disabled={busy}>
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
              {settingTypes.map((s) => (
                <li key={s.key}>
                  <span className="font-medium text-zinc-600 dark:text-zinc-300">{s.label}</span>
                  ：{s.judge}
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <span className="font-medium text-zinc-600 dark:text-zinc-300">不可变 / 可变</span>
              ：表单分两栏——「不可变」栏的内容 AI 永不违背；「可变」栏随剧情演变（如性格成长，AI 会自动记住）。
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
              {specOf(t)?.label ?? t} — {specOf(t)?.hint ?? ""}
            </option>
          ))}
        </select>
        {editing && <p className="shrink-0 text-[11px] text-zinc-400">类型不可修改（如需更换类型，删除后重建）</p>}
        <p className="shrink-0 text-[11px] text-zinc-400">完整示例：{specOf(form.type)?.example ?? ""}</p>
        {form.type === "character" && (
          <label className="flex shrink-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-500">角色等级（AI 据此分配篇幅 / 视角）</span>
            <select
              className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.role_rank}
              onChange={(e) => setForm({ ...form, role_rank: e.target.value })}
            >
              {roleRanks.map((r) => (
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
              背景机构（正文只提名字就行，AI 不会一直提醒你要补全）
            </span>
          </label>
        )}
        <label className="flex shrink-0 flex-col gap-1">
          <span className="text-[11px] font-medium text-zinc-500">名称</span>
          <input
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder={`如：${specOf(form.type)?.name_hint ?? ""}`}
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
            placeholder={specOf(form.type)?.desc_hint ?? ""}
            rows={3}
            value={form.dynamic_text}
            onChange={(e) => setForm({ ...form, dynamic_text: e.target.value })}
          />
        </label>
        <p className="shrink-0 text-[11px] leading-4 text-zinc-400">类型提示：{specOf(form.type)?.constitution_advice ?? ""}</p>
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
  );
}
