/**
 * @file components/settings/meta-panel.tsx
 * 「世界背景类型与题材 + 时代行业研究」左栏（由 settings-panel.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——背景类型/题材的选中值与保存动作、时代行业研究的
 * 数据与「编辑」入口均由父组件通过 props 下发（metaDirty 是否需保存由父组件算好后传入）。
 */
"use client";

import InfoTip from "@/components/info-tip";
import { BackgroundTypePicker, GenrePicker } from "@/components/novel-meta";
import { EraListCard } from "./era";
import type { Novel } from "@/lib/api";

interface Props {
  bgType: Novel["background_type"];
  onBgTypeChange: (v: Novel["background_type"]) => void;
  genres: string[];
  onGenresChange: (v: string[]) => void;
  metaBusy: boolean;
  metaDirty: boolean;
  onSaveMeta: () => void;
  /** 时代行业研究是否展示：仅「现实年代 / 半架空」展示（由父组件按背景类型判定）。 */
  showEraResearch: boolean;
  eraResearch: Record<string, unknown> | null | undefined;
  onEditEra: () => void;
}

/** 左侧参考栏：窄栏竖排，内容多时独立滚动；主区留给设定列表。 */
export default function SettingsSidebar({
  bgType,
  onBgTypeChange,
  genres,
  onGenresChange,
  metaBusy,
  metaDirty,
  onSaveMeta,
  showEraResearch,
  eraResearch,
  onEditEra,
}: Props) {
  return (
    <div className="flex min-h-0 flex-col gap-4 lg:w-[400px] lg:shrink-0 lg:self-start lg:max-h-full lg:overflow-y-auto lg:pr-1">
      {/* 世界背景类型与题材：创建时可留空，导入蓝图时 AI 按素材推断、弹窗引导作者确认；这里可直接修改 */}
      <section className="panel flex shrink-0 flex-col gap-2.5">
        <div className="panel-head mb-0">
          <div className="flex items-center gap-1.5">
            <h3 className="panel-title">世界背景类型与题材</h3>
            <InfoTip width="w-80" side="bottom">
              <p>
                <span className="font-medium text-zinc-800 dark:text-zinc-100">这本书属于哪个世界背景、什么题材。</span>
                背景类型决定平台签约时会不会去核查设定（现实 / 半架空 / 纯架空），题材是软性写作方向。
                不确定可以先不选，导入蓝图时 AI 会先猜一个，弹窗请你确认后自动保存，你也可以在这里直接改。
              </p>
            </InfoTip>
          </div>
          {/* 有未保存改动时显示「保存修改」：按钮始终占位（无改动时 invisible），
              避免按钮出现/消失引发模块与整页布局抖动；固定宽度防「保存中…」文字变化抖动 */}
          <button
            type="button"
            disabled={metaBusy}
            className={`btn btn-primary min-w-[92px] px-3 py-1.5 text-xs ${metaDirty ? "" : "invisible"}`}
            onClick={onSaveMeta}
          >
            {metaBusy ? "保存中…" : "保存修改"}
          </button>
        </div>
        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="text-[12px] font-medium text-zinc-500">世界背景类型</p>
            <BackgroundTypePicker value={bgType} onChange={onBgTypeChange} />
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-[12px] font-medium text-zinc-500">题材（可多选）</p>
            <GenrePicker value={genres} onChange={onGenresChange} />
          </div>
        </div>
      </section>

      {/* 时代行业研究：仅「现实年代 / 半架空」展示（选中后才出现，默认隐藏）；蓝图生成时自动研究，作者可查看/修改 */}
      {showEraResearch && (
        <section className="panel flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          <div className="panel-head mb-0">
            <div className="flex items-center gap-1.5">
              <h3 className="panel-title">时代行业研究</h3>
              <InfoTip width="w-80" side="bottom">
                <p>
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">这本书所处的年代×行业长什么样。</span>
                  生成蓝图时自动研究一次，
                  后面生成设定、写作、检查时都会参考它，避免机构、老板、业务写得不符当时情况。
                  换一本小说会自动重新研究。你可以在这里直接查看和修改。
                </p>
              </InfoTip>
            </div>
            {eraResearch ? (
              <div className="flex items-center gap-2">
                <span className="panel-hint">生成蓝图时自动研究</span>
                <button type="button" className="btn btn-ghost px-3 py-1.5 text-xs" onClick={onEditEra}>
                  编辑
                </button>
              </div>
            ) : (
              <span className="panel-hint">尚未研究（生成蓝图时自动研究）</span>
            )}
          </div>

          {eraResearch ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-[12.5px]">
                <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">开局年份</span><span className="text-zinc-700 dark:text-zinc-200">{String(eraResearch.story_start_year ?? "（未判定）")}</span></span>
                <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">时代定位</span><span className="text-zinc-700 dark:text-zinc-200">{String(eraResearch.era ?? "（未明确）")}</span></span>
                <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">行业</span><span className="text-zinc-700 dark:text-zinc-200">{String(eraResearch.industry ?? "（未明确）")}</span></span>
                <span><span className="mr-2 text-[10px] font-medium tracking-[0.2em] text-zinc-400">判定</span><span className="text-zinc-500">{String(eraResearch.note ?? "—")}</span></span>
              </div>
              {Boolean(eraResearch.boss_portrait) && (
                <p className="rounded-lg bg-sunken/40 px-3 py-2 text-[12.5px] leading-5 text-zinc-600 dark:text-zinc-300">
                  <span className="mr-2 align-middle text-[11px] font-medium text-zinc-500">老板 / 负责人画像</span>
                  {String(eraResearch.boss_portrait)}
                </p>
              )}
              {Boolean(eraResearch.location_pattern) && (
                <p className="rounded-lg bg-sunken/40 px-3 py-2 text-[12.5px] leading-5 text-zinc-600 dark:text-zinc-300">
                  <span className="mr-2 align-middle text-[11px] font-medium text-zinc-500">地域分布特征</span>
                  {String(eraResearch.location_pattern)}
                </p>
              )}
              {(Array.isArray(eraResearch.organization_forms) && eraResearch.organization_forms.length > 0) ||
               (Array.isArray(eraResearch.business_list) && eraResearch.business_list.length > 0) ||
               (Array.isArray(eraResearch.evolution) && eraResearch.evolution.length > 0) ||
               (Array.isArray(eraResearch.era_mismatch_red_flags) && eraResearch.era_mismatch_red_flags.length > 0) ? (
                <div className="grid gap-2.5">
                  {Array.isArray(eraResearch.organization_forms) && eraResearch.organization_forms.length > 0 && (
                    <EraListCard title="机构典型形态" tone="jade" items={eraResearch.organization_forms} />
                  )}
                  {Array.isArray(eraResearch.business_list) && eraResearch.business_list.length > 0 && (
                    <EraListCard title="业务范围" tone="dai" items={eraResearch.business_list} />
                  )}
                  {Array.isArray(eraResearch.evolution) && eraResearch.evolution.length > 0 && (
                    <EraListCard title="行业阶段演进" tone="ochre" items={eraResearch.evolution} />
                  )}
                  {Array.isArray(eraResearch.era_mismatch_red_flags) && eraResearch.era_mismatch_red_flags.length > 0 && (
                    <EraListCard title="时代错位雷点" tone="seal" items={eraResearch.era_mismatch_red_flags} warning />
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-[12.5px] leading-5 text-zinc-400 dark:border-zinc-700">
              现实题材下，点击「蓝图 → 生成蓝图」会自动研究这本书的年代×行业（机构形态、老板画像、业务范围等），
              之后生成设定、写作、检查时都会参考它；纯架空小说不触发研究。
            </p>
          )}
        </section>
      )}
    </div>
  );
}
