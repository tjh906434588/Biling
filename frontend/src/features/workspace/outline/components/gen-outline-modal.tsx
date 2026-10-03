/**
 * @file components/outline/gen-outline-modal.tsx
 * 大纲页「新增大纲 / 重写本章」弹窗（展示型子组件，由 outline-panel.tsx 拆分）：
 * 章节号自动推导提示 + 视角角色下拉（按戏份分组、含「这章不能出场」置灰项）+ 章节功能 + 本章目标表单。
 * 不持有 state：表单值 form 与回调均由父组件传入，生成流程仍在父组件 handleGenerate 中；
 * rewriteChapterNo != null 时是「重写本章」：章节号锁定，生成的是本章的新版本（与旧版本各自独立）。
 */
"use client";

import { useEffect, useState } from "react";
import type { Setting } from "@/lib/api";
import Modal from "@/components/modal";
import { CostHint } from "@/lib/ai-status";
import { ROLE_RANKS, STAGE_LABEL, loadChapterFunctions, type ChapterFunctionOption, type VolumeInfo } from "@/constants";
import { inactiveReason, roleRankOf, type GenForm } from "./outline-utils";

interface Props {
  open: boolean;
  /** null = 新增大纲（章节号自动推导）；number = 重写指定章（章节号锁定）。 */
  rewriteChapterNo: number | null;
  /** 生成表单（父组件持有，打开弹窗时重置；重写模式章节号锁定）。 */
  form: GenForm;
  /** 当前章节号所处阶段（early/middle/late，供提示文案与角色过滤）。 */
  stage: string | null;
  /** 视角角色下拉数据源：当前章节号下生效的角色（按戏份分组）。 */
  activeCharacters: Setting[];
  /** 当前章节号下不生效的角色（置灰展示原因）。 */
  inactiveCharacters: Setting[];
  /** 生效蓝图标题：null = 无生效蓝图（新增大纲的前提，无蓝图时弹窗内提示并禁用生成）。 */
  blueprintTitle: string | null;
  /** 生成进行中：驱动按钮禁用与文案切换。 */
  generating: boolean;
  /** 生效蓝图的分卷信息（推导角色不生效原因用）。 */
  volumes: VolumeInfo[];
  onClose: () => void;
  onFormChange: (f: GenForm) => void;
  onGenerate: () => void;
  onShowStream: () => void;
}

export default function GenOutlineModal({
  open,
  rewriteChapterNo,
  form,
  stage,
  activeCharacters,
  inactiveCharacters,
  blueprintTitle,
  generating,
  volumes,
  onClose,
  onFormChange,
  onGenerate,
  onShowStream,
}: Props) {
  /** 章节功能下拉项（枚举字典，后端单一源；拉取前为空 → 下拉只剩「自动判定」）。 */
  const [chapterFunctions, setChapterFunctions] = useState<ChapterFunctionOption[]>([]);
  useEffect(() => {
    void loadChapterFunctions().then(setChapterFunctions);
  }, []);
  return (
    <Modal
      open={open}
      title={rewriteChapterNo != null ? `重写第 ${rewriteChapterNo} 章大纲` : "新增大纲"}
      subtitle={
        rewriteChapterNo != null
          ? "重写本章：生成一个新版本（未批准），与本章已有版本各自独立、互不影响。批准新版本后，AI 写本章时会优先参考它。"
          : "大纲 = 单章的施工图。AI 会按当前使用的蓝图，排出这一章的目标、节拍、冲突和视角。生成的是「未批准」版本，批准后，AI 写这一章时会优先照它来。"
      }
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost px-4 py-1.5"
          >
            取消
          </button>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">
              <CostHint />
            </span>
            <button
              type="button"
              onClick={onGenerate}
              disabled={generating || !blueprintTitle}
              className="btn btn-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating ? "生成中…" : rewriteChapterNo != null ? "重新生成大纲" : "生成大纲"}
            </button>
            {/* 点击生成后出现：打开生成过程弹窗（DeepSeek 风格，思考+正文流式滚动） */}
            {generating && (
              <button
                type="button"
                onClick={onShowStream}
                className="btn btn-ghost px-3 py-1.5"
              >
                查看生成过程
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* 无生效蓝图时提醒（新增大纲的前提）；有蓝图则不打扰 */}
        {!blueprintTitle && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-6 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            还没有生效的蓝图，无法生成大纲。
            <br />
            请先到「蓝图」页创建蓝图并设为当前使用，再回来新增大纲。
          </div>
        )}

        {/* 章节号不手动填写：打开弹窗时已自动推导（已有大纲最大章号 + 1，无则从第一卷第一章开始） */}
        <span className="text-[11px] text-zinc-400">
          {rewriteChapterNo != null ? (
            <>
              将重写：第 {rewriteChapterNo} 章
              {stage ? `（当前处于：${STAGE_LABEL[stage]}，这个阶段能出场的角色如下）` : ""}
            </>
          ) : (
            <>
              将自动生成：第 {form.chapter_no} 章
              {stage ? `（当前处于：${STAGE_LABEL[stage]}，这个阶段能出场的角色如下）` : ""}
            </>
          )}
        </span>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">视角角色</span>
          <select
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            value={form.pov}
            onChange={(e) => onFormChange({ ...form, pov: e.target.value })}
            disabled={generating}
          >
            <option value="">
              {activeCharacters.length > 0
                ? "视角角色（留空由 AI 自定）"
                : "该章节无生效角色（留空由 AI 自定）"}
            </option>
            {ROLE_RANKS.map((g) => {
              const items = activeCharacters.filter((c) => roleRankOf(c) === g.value);
              if (items.length === 0) return null;
              return (
                <optgroup key={g.value} label={g.label}>
                  {items.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            {activeCharacters.some((c) => !ROLE_RANKS.some((g) => roleRankOf(c) === g.value)) && (
              <optgroup label="未标注等级">
                {activeCharacters
                  .filter((c) => !ROLE_RANKS.some((g) => roleRankOf(c) === g.value))
                  .map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {inactiveCharacters.length > 0 && (
              <optgroup label="这章不能出场（不能选）">
                {inactiveCharacters.map((c) => (
                  <option key={c.id} value={c.name} disabled>
                    {c.name}（{inactiveReason(c, form.chapter_no, volumes)}）
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">章节功能</span>
          <select
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            value={form.chapter_function}
            onChange={(e) => onFormChange({ ...form, chapter_function: e.target.value })}
            disabled={generating}
          >
            <option value="">本章节奏定位：自动判定</option>
            {chapterFunctions.map((f) => (
              <option key={f.value} value={f.value}>
                本章节奏定位：{f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">本章目标</span>
          <textarea
            className="resize-none rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            placeholder="本章目标（留空则由 AI 自行把握）"
            rows={2}
            value={form.goal}
            onChange={(e) => onFormChange({ ...form, goal: e.target.value })}
            disabled={generating}
          />
        </label>
        {/* 生成中的实时展示移入独立的「生成过程弹窗」（AgentStreamModal，参考蓝图页）。 */}
      </div>
    </Modal>
  );
}
