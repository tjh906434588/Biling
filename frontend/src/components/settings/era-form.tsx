/**
 * @file components/settings/era-form.tsx
 * 「编辑时代行业研究」弹窗（由 settings-panel.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——表单状态 form / setForm、保存忙碌态 busy 与保存/关闭
 * 动作均由父组件下发；每个字段复用 era.tsx 的 EraField（输入框/多行文本）。
 */
"use client";

import type { Dispatch, SetStateAction } from "react";
import Modal from "../modal";
import { EraField, type EraFormState } from "./era";

interface Props {
  open: boolean;
  form: EraFormState;
  setForm: Dispatch<SetStateAction<EraFormState>>;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
}

/** 「编辑时代行业研究」弹窗：每一项一行；全部清空后保存 = 删掉这份研究。 */
export default function EraEditModal({ open, form, setForm, busy, onSave, onClose }: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="编辑时代行业研究"
      subtitle="生成蓝图时自动研究一次；修改后蓝图 / 设定 / 评价都会参考。每一项一行；全部清空后保存 = 删掉这份研究。"
      maxWidth="max-w-2xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost px-4 py-1.5 text-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary px-4 py-1.5 text-sm" onClick={onSave} disabled={busy}>
            {busy ? "保存中…" : "保存修改"}
          </button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2.5">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <EraField
            label="开局年份"
            hint="故事从哪一年开始"
            placeholder="如：2000"
            value={form.story_start_year}
            onChange={(v) => setForm({ ...form, story_start_year: v })}
          />
          <EraField
            label="行业"
            hint="判定出的行业"
            placeholder="如：人才中介 / 职业介绍"
            value={form.industry}
            onChange={(v) => setForm({ ...form, industry: v })}
          />
        </div>
        <EraField
          label="时代定位"
          hint="如：2000 年代起的现代都市"
          value={form.era}
          onChange={(v) => setForm({ ...form, era: v })}
        />
        <EraField
          label="判定依据"
          hint="AI 是从哪里判断出这个年代与行业的"
          textarea
          rows={2}
          value={form.note}
          onChange={(v) => setForm({ ...form, note: v })}
        />
        <EraField
          label="老板 / 负责人画像"
          textarea
          rows={2}
          value={form.boss_portrait}
          onChange={(v) => setForm({ ...form, boss_portrait: v })}
        />
        <EraField
          label="地域分布特征"
          hint="门店 / 机构通常开在哪里、为什么"
          textarea
          rows={2}
          value={form.location_pattern}
          onChange={(v) => setForm({ ...form, location_pattern: v })}
        />
        <EraField
          label="机构典型形态"
          hint="一行一条"
          textarea
          rows={3}
          value={form.organization_forms}
          onChange={(v) => setForm({ ...form, organization_forms: v })}
        />
        <EraField
          label="业务范围"
          hint="一行一条"
          textarea
          rows={3}
          value={form.business_list}
          onChange={(v) => setForm({ ...form, business_list: v })}
        />
        <EraField
          label="行业阶段演进时间轴"
          hint="一行一条，带起止年份"
          textarea
          rows={3}
          value={form.evolution}
          onChange={(v) => setForm({ ...form, evolution: v })}
        />
        <EraField
          label="时代错位雷点"
          hint="一行一条，写作红线（需带时间前提）"
          textarea
          rows={3}
          value={form.era_mismatch_red_flags}
          onChange={(v) => setForm({ ...form, era_mismatch_red_flags: v })}
        />
      </div>
    </Modal>
  );
}
