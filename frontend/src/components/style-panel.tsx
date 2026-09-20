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

const TRAIT_FIELDS: Array<[keyof NonNullable<StyleProfile["traits"]>, string]> = [
  ["sentence_length", "句式长短"],
  ["vocabulary", "用词倾向"],
  ["perspective", "视角叙述"],
  ["dialogue_ratio", "对话比例"],
  ["rhythm", "节奏结构"],
];

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      try {
        const novel = await getNovel(novelId);
        setBlueprintDirective(novel.style_directive ?? "");
        setManualDirective(novel.style_directive_manual ?? "");
      } catch (e) {
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

  const startEdit = useCallback(() => {
    setDraftManual(manualDirective);
    setEditingManual(true);
  }, [manualDirective]);

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

  const latest = profiles[0] ?? null;

  return (
    <Loading loading={loading}>
      <div className="grid gap-6">
        <section className="flex min-w-0 flex-col gap-5 sm:gap-7">
        <div className="panel flex h-[calc(100dvh-6rem)] flex-col">
          <div className="panel-head">
            <div className="flex items-center gap-1.5">
              <h3 className="panel-title">全局文风描述</h3>
              <InfoTip width="w-80" side="bottom">
                <ul className="list-disc space-y-1 pl-4">
                  <li>蓝图识别文风：导入蓝图时从大纲文档提炼的文风。</li>
                  <li>手动添加文风：作者手动维护，导入蓝图不会覆盖。</li>
                  <li>两者冲突时以蓝图识别为准；手动部分与蓝图不冲突时也必须严格遵守。</li>
                  <li>小说家与修订师每次生成都会读取以上两部分文风。</li>
                </ul>
              </InfoTip>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 gap-4 sm:grid-cols-2 [grid-template-rows:minmax(0,1fr)]">
            {/* 左：蓝图识别（只读，展示当前生效蓝图的那一份）—— 暖色嵌套面 + 靛青点缀，去掉冷蓝块 */}
            <div className="flex h-full min-h-0 min-w-0 flex-col rounded-lg border border-zinc-200 bg-sunken/50 p-3 dark:border-zinc-800 dark:bg-sunken/40">
              <div className="mb-1 flex h-6 items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-xs font-semibold text-dai dark:text-dai">
                  蓝图识别文风
                  <InfoTip side="bottom">导入蓝图时从大纲文档提炼的文风，只读</InfoTip>
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="rounded-full border border-dai/50 px-1.5 py-0.5 text-[10px] text-dai dark:border-dai/60">蓝图导入</span>
                  <span className="rounded-full border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">只读</span>
                </div>
              </div>
              {blueprintDirective.trim() ? (
                <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-sunken/50 p-2.5 font-serif text-xs leading-relaxed text-prose dark:border-zinc-800 dark:bg-sunken/40">
                  {blueprintDirective}
                </div>
              ) : (
                <p className="flex-1 rounded-lg bg-sunken/70 p-2.5 text-xs text-zinc-400">
                  当前生效蓝图未提炼文风，暂无展示内容。
                </p>
              )}
            </div>

            {/* 右：手动添加（默认文字展示，点「编辑」才出输入框） */}
            <div className="flex h-full min-h-0 min-w-0 flex-col rounded-lg border border-zinc-200 bg-sunken/50 p-3 dark:border-zinc-800 dark:bg-sunken/40">
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
                <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-sunken/50 p-2.5 font-serif text-xs leading-relaxed text-prose dark:border-zinc-800 dark:bg-sunken/40">
                  {manualDirective}
                </div>
              ) : (
                <p className="flex-1 rounded-lg bg-sunken/70 p-2.5 text-xs text-zinc-400">还没有手动文风。点「编辑」添加，导入蓝图不会覆盖它。</p>
              )}
            </div>
          </div>

          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            注意：这里只能写「描述」，<strong>不要直接粘贴他人作品原文</strong>。外部文本会以风格示例身份混入本小说上下文，既不准确也带版权风险。
          </p>
        </div>

        {profiles.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h3 className="panel-title">风格画像版本</h3>
              <span className="panel-hint">共 {profiles.length} 版 · 最新一版生效</span>
            </div>
            <div className="flex flex-col gap-2.5">
              {profiles.map((p) => (
                <div key={p.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-medium">v{p.version}</span>
                    {p.version === (latest?.version ?? 0) && (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
                        当前生效
                      </span>
                    )}
                    {p.source_diff_ids?.length ? (
                      <span className="text-[11px] text-zinc-500">来源 {p.source_diff_ids.length} 处编辑</span>
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
                    <p className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-xs italic text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
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
