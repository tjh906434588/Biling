/**
 * @file writing/review-card.tsx
 * 评价师结果卡片：整体分 + 六维评分（含读者追读子项）+ 问题（可逐条「有异议」标记）+
 * 亮点 + 修改建议 + 作者批注 + 按评价优化。常驻于写作页右侧「评价与优化」侧栏。
 * 纯展示组件：评价数据与回调全部由 props 传入，作者批注/异议草稿为组件本地状态。
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  loadRetentionHookLabels,
  loadRubricLabels,
  loadSeverityLabels,
} from "@/constants";
import type { QualityReview } from "@/lib/api";

/** 评价师结果卡片：整体分 + 六维评分 + 问题 + 亮点 + 修改建议 + 按评价优化。 */
export function ReviewCard({
  review,
  onRevise,
  revising,
  activeVersionId,
  viewButton,
}: {
  review: QualityReview;
  onRevise: (r: QualityReview, authorInput?: { note?: string; disagreements?: Record<number, string> }) => void;
  revising: boolean;
  /** 当前预览选中的版本 id：评价与选中版本对得上才可「按评价优化」。 */
  activeVersionId: string | null;
  /** 出现在「按评价优化本章」左侧的附加按钮（如：查看 AI 过程）。 */
  viewButton?: ReactNode;
}) {
  /** 评价维度/追读力子项/严重度中文标签（枚举字典，后端单一源；拉取前显示原始 value） */
  const [rubricLabels, setRubricLabels] = useState<Record<string, string>>({});
  const [hookLabels, setHookLabels] = useState<Record<string, string>>({});
  const [severityLabels, setSeverityLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    void Promise.all([loadRubricLabels(), loadRetentionHookLabels(), loadSeverityLabels()]).then(
      ([r, h, s]) => {
        setRubricLabels(r);
        setHookLabels(h);
        setSeverityLabels(s);
      },
    );
  }, []);
  const rubric = review.rubric ?? {};
  const rubricEntries = Object.entries(rubric);
  const scoreColor = (s?: number) =>
    s == null ? "" : s >= 80 ? "text-green-600" : s >= 60 ? "text-amber-600" : "text-red-600";
  /** 评价是否针对当前预览选中的版本（原 is_current 由后端按激活版本标记 → 改为按选中版本判断）。 */
  const matchesActive = activeVersionId != null && review.chapter_version_id === activeVersionId;
  /** 作者对某条问题有异议的理由（key=问题序号）；异议随优化传给修订师，优先级高于评价师。 */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /** 作者整体批注（可选）：随优化传给修订师，优先级高于评价师。 */
  const [note, setNote] = useState("");
  /** 当前展开异议输入框的问题序号（null=全部收起）。 */
  const [openDraft, setOpenDraft] = useState<number | null>(null);
  return (
    <div className="rounded-lg bg-sunken/40 p-4">
      <div className="mb-3 flex items-center gap-3">
        <span className={`text-4xl font-bold ${scoreColor(review.overall_score ?? undefined)}`}>
          {review.overall_score ?? "—"}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold">本章评审</h3>
            {review.version_no != null && (
              <span
                title={
                  matchesActive
                    ? `针对当前选中的第${review.version_no}版正文`
                    : "针对其他版本（当前未选中）"
                }
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  matchesActive
                    ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                    : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                }`}
              >
                第{review.version_no}版
                {matchesActive ? "" : " · 未选中"}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500">
            {review.created_at ? new Date(review.created_at).toLocaleString() : ""}
            {review.chapter_title ? ` · ${review.chapter_title}` : ""}
          </p>
        </div>
      </div>

      {rubricEntries.length > 0 && (
        <div className="mb-3 grid gap-2 @2xl:grid-cols-2">
          {rubricEntries.map(([k, v]) => {
            const isRetention = k === "reader_retention";
            const hookEntries = Object.entries(v?.hooks ?? {});
            const retentionRisk =
              isRetention && typeof v?.score === "number" && v.score < 65;
            return (
              <div
                key={k}
                className={`rounded-lg border p-2.5 dark:border-zinc-800 ${
                  isRetention
                    ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/40"
                    : "border-zinc-200"
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    {rubricLabels[k] ?? k}
                  </span>
                  <span className={`text-sm font-bold ${scoreColor(v?.score)}`}>{v?.score ?? "—"}</span>
                </div>
                {isRetention && hookEntries.length > 0 && (
                  <div className="mb-1.5 grid grid-cols-2 gap-1">
                    {hookEntries.map(([hk, hs]) => (
                      <div
                        key={hk}
                        className="flex items-center justify-between rounded bg-zinc-100 px-1.5 py-1 text-[11px] dark:bg-zinc-900"
                      >
                        <span className="text-zinc-500">{hookLabels[hk] ?? hk}</span>
                        <span className={`font-semibold ${scoreColor(hs)}`}>{hs ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-zinc-600 dark:text-zinc-300">{v?.comment}</p>
                {retentionRisk && (
                  <p className="mt-1.5 rounded bg-red-100 px-2 py-1 text-[11px] font-medium text-red-700 dark:bg-red-900 dark:text-red-300">
                    追读风险：本章低于 65 分，读者可能划走不追更，建议按评语改完重新评价。
                  </p>
                )}
                {v?.evidence && (
                  <p className="mt-1 border-l-2 border-zinc-200 pl-2 text-[11px] text-zinc-400 dark:border-zinc-700">
                    {v.evidence}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {review.issues && review.issues.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">问题</h4>
          <ul className="flex flex-col gap-1.5">
            {review.issues.map((i, idx) => (
              <li
                key={idx}
                className={`rounded-lg border p-2.5 text-xs ${
                  drafts[idx]?.trim()
                    ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950"
                    : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="mr-1.5 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-700 dark:bg-red-900 dark:text-red-300">
                      {i.severity ? (severityLabels[i.severity] ?? i.severity) : "?"}
                    </span>
                    {i.desc}
                    {i.suggested_fix && (
                      <span className="mt-1 block text-red-700/80 dark:text-red-300/80">改法：{i.suggested_fix}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenDraft((v) => (v === idx ? null : idx))}
                    title={
                      drafts[idx]?.trim()
                        ? "已标记有异议，该条将保留原文不修改（点击修改理由）"
                        : "不认可这条建议？标记并写理由，AI 优化时会保留原文、不按此条修改"
                    }
                    className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                      drafts[idx]?.trim()
                        ? "border-amber-400 bg-amber-100 text-amber-700 dark:border-amber-600 dark:bg-amber-900 dark:text-amber-300"
                        : "border-zinc-300 text-zinc-500 hover:border-amber-400 hover:text-amber-600 dark:border-zinc-700 dark:text-zinc-400"
                    }`}
                  >
                    {drafts[idx]?.trim() ? "有异议 ✓" : "有异议"}
                  </button>
                </div>
                {openDraft === idx && (
                  <textarea
                    value={drafts[idx] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [idx]: e.target.value }))}
                    placeholder="说明哪里不对 / 与上文哪处冲突（可选；AI 优化时会跳过这条，或按你的意见改）"
                    rows={2}
                    className="mt-2 w-full resize-none rounded-md border border-zinc-300 bg-white p-1.5 text-xs outline-none focus:border-amber-400 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 @2xl:grid-cols-2">
        {review.strengths && review.strengths.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-green-600 dark:text-green-400">亮点</h4>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-zinc-600 dark:text-zinc-300">
              {review.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {review.revision_hints && review.revision_hints.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">修改建议</h4>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-zinc-600 dark:text-zinc-300">
              {review.revision_hints.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {matchesActive ? (
        <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p className="mb-1.5 text-[11px] text-zinc-500">
            作者批注（可选，会记下来）
            <span className="text-zinc-400">
              ——评价里没提到、但你自己发现的问题（设定/关系/时间线不一致等），或想按自己的方式改，写在这里，AI 优化会照此修改。
              这条意见会保存到本章，之后重新生成/规划本章都会自动遵守，不会再说一次还照写。
              若想让某条评价建议保持原文，用问题右侧的「有异议」。
            </span>
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：本章王磊说『我租的房子在前面』，但前文交代过他是本地人、毕业住家里，请统一口径；主角的反应改成冷静处理…"
            rows={2}
            className="w-full resize-none rounded-md border border-zinc-300 bg-white p-2 text-xs outline-none focus:border-primary dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <p className="text-[11px] text-zinc-400">
              AI 会逐条对照以上问题优化当前选中的正文（第{review.version_no}版），保留原情节走向，改好后另存新的一版，原稿保留。
              「有异议」=保留原文不采纳该条；作者批注=按你的批注修改正文。都会传给 AI 优化，以你的意见为准。
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {viewButton}
              <button
                onClick={() => {
                  const disagreements = Object.entries(drafts).reduce<Record<number, string>>((acc, [k, v]) => {
                    if (v.trim()) acc[Number(k)] = v.trim();
                    return acc;
                  }, {});
                  const hasNote = note.trim().length > 0;
                  const hasDis = Object.keys(disagreements).length > 0;
                  onRevise(
                    review,
                    hasNote || hasDis
                      ? { note: hasNote ? note.trim() : undefined, disagreements: hasDis ? disagreements : undefined }
                      : undefined,
                  );
                }}
                disabled={revising}
                className="btn btn-primary shrink-0 px-3 py-1.5 text-xs font-medium"
              >
                {revising ? "AI 优化中…" : "按评价优化本章"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p className="text-[11px] text-zinc-400">
            这条评价是对第{review.version_no}版正文写的，当前选中的不是那一版。先切到那一版
            再优化，或直接对当前这版重新评价。
          </p>
        </div>
      )}
    </div>
  );
}
