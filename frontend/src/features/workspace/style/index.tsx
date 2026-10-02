/**
 * @file style-panel.tsx
 * 风格/文风面板：展示与维护小说的全局文风描述，并浏览按版本保存的风格画像。
 * 核心机制：文风分「蓝图识别（只读，导入蓝图时提炼）」与「手动添加（作者维护，
 * 导入蓝图不覆盖）」两部分，每次生成正文时都会读取；风格画像按版本保存，最新一版生效。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { getNovel, listStyleProfiles, updateNovel, type StyleProfile } from "@/lib/api";
import { useAiStatus } from "@/lib/ai-status";
import InfoTip from "@/components/info-tip";
import { message } from "@/components/message";
import Loading from "@/components/loading";

interface Props {
  novelId: string;
}

/** 风格画像中展示的五项特质（key → 中文标签），按此顺序渲染。 */
const TRAIT_FIELDS: Array<[keyof NonNullable<StyleProfile["traits"]>, string]> = [
  ["sentence_length", "句式长短"],
  ["vocabulary", "用词倾向"],
  ["perspective", "视角叙述"],
  ["dialogue_ratio", "对话比例"],
  ["rhythm", "节奏结构"],
];

/**
 * 风格/文风面板主组件。
 * @param novelId 当前小说 id。
 */
export default function StylePanel({ novelId }: Props) {
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  // 数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(true);
  // 手动添加文风：作者手动维护，导入蓝图不会覆盖
  const [manualDirective, setManualDirective] = useState("");
  // 蓝图识别文风：从当前生效蓝图读取（后端已同步），只读展示
  const [blueprintDirective, setBlueprintDirective] = useState("");
  const [savingDirective, setSavingDirective] = useState(false);
  const [editingManual, setEditingManual] = useState(false);
  const [draftManual, setDraftManual] = useState("");
  const { ensureReady } = useAiStatus();

  /** 加载文风描述（蓝图/手动）与风格画像；文风描述读取失败不阻塞画像加载。 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      try {
        const novel = await getNovel(novelId);
        setBlueprintDirective(novel.style_directive ?? "");
        setManualDirective(novel.style_directive_manual ?? "");
      } catch {
        // 风格画像仍可加载，文风描述读取失败不阻塞
      }
      try {
        setProfiles(await listStyleProfiles(novelId));
      } catch (e) {
        message.error((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 进入手动文风编辑：把当前值填入草稿。 */
  const startEdit = useCallback(() => {
    setDraftManual(manualDirective);
    setEditingManual(true);
  }, [manualDirective]);

  /** 保存手动文风：写入后更新展示并退出编辑态。 */
  async function handleSaveManualDirective() {
    setSavingDirective(true);
    try {
      ensureReady();
      await updateNovel(novelId, { style_directive_manual: draftManual.trim() });
      setManualDirective(draftManual.trim());
      setEditingManual(false);
      message.success("已保存手动文风");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSavingDirective(false);
    }
  }

  /** 最新一版风格画像（后端按版本倒序返回，第 0 个即最新），用于标记「当前生效」。 */
  const latest = profiles[0] ?? null;

  return (
    <Loading loading={loading} className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 gap-6 [grid-template-rows:minmax(0,1fr)]">
        <section className="flex min-h-0 min-w-0 flex-col gap-5 sm:gap-7">
        <div className="panel flex min-h-0 flex-col">
          <div className="panel-head">
            <div className="flex items-center gap-1.5">
              <h3 className="panel-title">整本书的文风描述</h3>
              <InfoTip width="w-80" side="bottom">
                <ul className="list-disc space-y-1 pl-4">
                  <li>蓝图识别文风：导入蓝图时从大纲文档提炼的文风。</li>
                  <li>手动添加文风：作者手动维护，导入蓝图不会覆盖。</li>
                  <li>两者冲突时以蓝图识别为准；手动部分与蓝图不冲突时也必须严格遵守。</li>
                  <li>AI 每次写正文时都会参考这两部分。</li>
                </ul>
              </InfoTip>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 gap-4 sm:grid-cols-2 [grid-template-rows:minmax(0,1fr)]">
            {/* 左：蓝图识别（只读，展示当前生效蓝图的那一份）—— 暖色嵌套面 + 靛青点缀，去掉冷蓝块 */}
            <div className="flex h-full min-h-0 min-w-0 flex-col rounded-lg bg-sunken/40 p-3">
              <div className="mb-1 flex h-6 items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-xs font-semibold text-dai dark:text-dai">
                  蓝图识别文风
                  <InfoTip side="bottom">导入蓝图时从大纲文档提炼的文风，自动生成，不能手改</InfoTip>
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="rounded-full border border-dai/50 px-1.5 py-0.5 text-[10px] text-dai dark:border-dai/60">蓝图导入</span>
                  <span className="rounded-full border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">自动生成，不能手改</span>
                </div>
              </div>
              {blueprintDirective.trim() ? (
                <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg bg-sunken/40 p-2.5 font-serif text-xs leading-relaxed text-prose">
                  {blueprintDirective}
                </div>
              ) : (
                <p className="flex-1 rounded-lg bg-sunken/70 p-2.5 text-xs text-zinc-400">
                  当前使用的蓝图没提炼文风，暂无展示内容。
                </p>
              )}
            </div>

            {/* 右：手动添加（默认文字展示，点「编辑」才出输入框） */}
            <div className="flex h-full min-h-0 min-w-0 flex-col rounded-lg bg-sunken/40 p-3">
              <div className="mb-1 flex h-6 items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                  手动添加文风
                  <InfoTip side="bottom">作者手动维护，导入蓝图不会覆盖</InfoTip>
                </span>
                <div className="flex items-center gap-1.5">
                  {!editingManual && (
                    <button
                      type="button"
                      className="rounded-full border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:border-zinc-500 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
                      onClick={startEdit}
                    >
                      编辑
                    </button>
                  )}
                </div>
              </div>
              {editingManual ? (
                <>
                  <textarea
                    className="w-full min-h-0 flex-1 resize-none rounded-lg border border-zinc-300 bg-sunken/50 p-2.5 font-serif text-xs leading-relaxed outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-sunken/40 dark:text-zinc-100"
                    value={draftManual}
                    onChange={(e) => setDraftManual(e.target.value)}
                  />
                  <div className="mt-2 flex shrink-0 items-center justify-end gap-2">
                    <button
                      type="button"
                      className="btn btn-ghost px-3 py-1 text-xs"
                      onClick={() => setEditingManual(false)}
                      disabled={savingDirective}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary px-3 py-1 text-xs"
                      onClick={handleSaveManualDirective}
                      disabled={savingDirective}
                    >
                      {savingDirective ? "保存中…" : "保存"}
                    </button>
                  </div>
                </>
              ) : manualDirective.trim() ? (
                <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg bg-sunken/40 p-2.5 font-serif text-xs leading-relaxed text-prose">
                  {manualDirective}
                </div>
              ) : (
                <p className="flex-1 rounded-lg bg-sunken/70 p-2.5 text-xs text-zinc-400">还没有手动文风。点「编辑」添加，导入蓝图不会覆盖它。</p>
              )}
            </div>
          </div>

          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            注意：这里只能写「描述」，<strong>不要直接粘贴他人作品原文</strong>。别人的作品原文会被当成你的风格样例灌给 AI，既不准确还可能侵权。
          </p>
        </div>

        {profiles.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h3 className="panel-title">文风分析记录</h3>
              <span className="panel-hint">共 {profiles.length} 版 · 最新一版在使用</span>
            </div>
            <div className="flex flex-col gap-2.5">
              {profiles.map((p) => (
                <div key={p.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-medium">v{p.version}</span>
                    {p.version === (latest?.version ?? 0) && (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
                        正在使用
                      </span>
                    )}
                    {p.source_diff_ids?.length ? (
                      <span className="text-[11px] text-zinc-500">基于 {p.source_diff_ids.length} 处修改生成</span>
                    ) : null}
                  </div>
                  <dl className="grid gap-1 text-xs sm:grid-cols-2">
                    {TRAIT_FIELDS.map(([key, label]) => (
                      <div key={key} className="rounded bg-zinc-50 p-2 dark:bg-zinc-900">
                        <dt className="font-medium text-zinc-500">{label}</dt>
                        <dd className="mt-0.5 text-zinc-700 dark:text-zinc-300">{p.traits?.[key] || "（未标注）"}</dd>
                      </div>
                    ))}
                  </dl>
                  {p.traits?.example_fragment && (
                    <p className="mt-2 rounded-lg bg-zinc-50 p-2 text-xs italic text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                      {p.traits.example_fragment}
                    </p>
                  )}
                  {p.avoid_list && p.avoid_list.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {p.avoid_list.map((a, i) => (
                        <li key={i} className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700 dark:bg-red-900 dark:text-red-300">
                          忌：{a}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      </div>
    </Loading>
  );
}
