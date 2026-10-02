/**
 * @file detect-panel.tsx
 * 体检面板：粘贴文本或取章节正文做 AI 成稿倾向检测（签约合规检测 / 文风检测）。
 * 核心机制：三层信号参考——词法规则命中（regex_hits）、密度指纹（句长/连接词/虚词等）、
 * 突发性启发式（困惑度 ppl + 突发性 burstiness），综合给出 verdict 判定与启发式得分，
 * 不设硬阈值、不阻断写作，仅作提示。
 * 布局：左侧「AI生成检测」输入区撑满页面高度（标题带 ? 悬浮说明），
 * 右侧为结论区：判定（三分类占比饼图 + 指标）、模板词、句长统计。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { detectText, listChapters, type ChapterListItem, type DetectResult } from "@/lib/api";
import { message } from "@/components/message";
import Loading from "@/components/loading";
import InfoTip from "@/components/info-tip";

const VERDICT_STYLE: Record<string, string> = {
  likely_human: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  mixed: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  likely_ai: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const VERDICT_LABEL: Record<string, string> = {
  likely_human: "疑似人类",
  mixed: "混合",
  likely_ai: "疑似 AI",
  unknown: "无法判定",
};

/** 三分类饼图配色与图例（与结论 pill 一致：人工=绿 / 疑似=琥珀 / AI=红）。 */
const PIE_SEGMENTS = [
  { key: "human" as const, label: "人工特征", color: "#22c55e" },
  { key: "suspected" as const, label: "疑似 AI", color: "#f59e0b" },
  { key: "ai" as const, label: "AI 特征", color: "#ef4444" },
];

/** 指标小卡：展示单项检测数值；accent 时加深底色以突出（综合得分用）。 */
function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-lg">{value}</div>
    </div>
  );
}

/**
 * 三分类占比：优先取后端 labels_ratio（人工/疑似AI/AI，合计≈100）；
 * 缺失时降级用启发式得分近似（human=100-score，ai=score）。
 */
function ratioOf(result: DetectResult): { human: number; ai: number; suspected: number } {
  if (result.labels_ratio) return result.labels_ratio;
  const score = result.heuristic_score;
  return { human: Math.max(0, 100 - score), ai: score, suspected: 0 };
}

/**
 * 判定饼图（朱雀 AI 检测助手 labels_ratio 风格）：
 * 环形三段 人工特征 / 疑似 AI / AI 特征，占比大的从 12 点方向开始，
 * 中心显示最大占比的结论，右侧图例逐一列出三类占比。
 */
function VerdictPie({ result }: { result: DetectResult }) {
  const ratio = ratioOf(result);
  const segments = PIE_SEGMENTS.map((s) => ({
    ...s,
    value: Math.max(0, Math.round(ratio[s.key])),
  })).sort((a, b) => b.value - a.value);
  const drawn = segments.filter((s) => s.value > 0);
  const total = Math.max(segments.reduce((a, s) => a + s.value, 0), 100);
  const top = segments[0];

  const SIZE = 128;
  const STROKE = 16;
  const R = (SIZE - STROKE) / 2;
  const C = 2 * Math.PI * R;

  // 预计算每段弧长与起始偏移（strokeDashoffset 相对 3 点钟方向顺时针累计）
  const arcs = drawn.reduce<Array<{ s: (typeof drawn)[number]; len: number; offset: number }>>(
    (arr, s) => {
      const len = (s.value / total) * C;
      const offset = arr.length ? arr[arr.length - 1].offset + arr[arr.length - 1].len : 0;
      arr.push({ s, len, offset });
      return arr;
    },
    [],
  );

  return (
    <div className="flex items-center gap-5">
      <div className="relative h-[128px] w-[128px] shrink-0">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full w-full -rotate-90">
          {arcs.map(({ s, len, offset }) => (
            <circle
              key={s.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] leading-4 text-zinc-500">{top.value > 0 ? top.label : "无数据"}</span>
          <span className="font-mono text-xl font-semibold leading-6" style={{ color: top.color }}>
            {top.value}%
          </span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px]">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="text-zinc-600 dark:text-zinc-300">{s.label}</span>
            <span className="ml-auto font-mono text-xs text-zinc-500">{s.value}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 体检面板主组件。
 * @param novelId 当前小说 id，用于拉取章节列表与提交检测。
 */
export default function DetectPanel({ novelId }: { novelId: string }) {
  const [chapters, setChapters] = useState<ChapterListItem[]>([]);
  const [text, setText] = useState("");
  /** 当前选中的章节号；"" = 未选择（下拉占位值，检测时转成 number） */
  const [chapterNo, setChapterNo] = useState<number | "">("");
  /** 最近一次检测结果；null = 尚未检测 */
  const [result, setResult] = useState<DetectResult | null>(null);
  const [loading, setLoading] = useState(false);
  // 章节下拉数据加载中：遮罩过渡，加载完成后解除
  const [chaptersLoading, setChaptersLoading] = useState(true);
  useEffect(() => {
    listChapters(novelId)
      .then(setChapters)
      .catch(() => {})
      .finally(() => setChaptersLoading(false));
  }, [novelId]);

  /** 模板词命中：去掉 0 值，按命中次数降序 */
  const tplWords = Object.entries(result?.regex_hits ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  /** 提交文本检测：调用后端 detectText，成功后写入 result，失败弹错误提示。 */
  const runDetect = useCallback(
    async (payload: string) => {
      setLoading(true);
      try {
        setResult(await detectText(novelId, payload));
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [novelId],
  );

  /** 取章检测：把选中章节的「当前生效版本」正文填入文本区并立即检测；无正文时提示。 */
  const detectChapter = async () => {
    if (chapterNo === "") return;
    // 按章节号找到对应章节，取其已选版本正文
    const ch = chapters.find((c) => c.chapter_no === Number(chapterNo));
    const content = ch?.active_content;
    if (!content) {
      message.error("该章节尚无已选版本正文");
      return;
    }
    setText(content);
    await runDetect(content);
  };

  return (
    <Loading loading={chaptersLoading} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row lg:gap-5">
        {/* ── 左：AI生成检测（撑满页面高度） ─────────────────── */}
        <section className="panel flex min-h-[420px] flex-col gap-2.5 lg:h-full lg:min-h-0 lg:flex-1">
          <div className="panel-head">
            <h2 className="panel-title">
              AI生成检测
              <InfoTip width="w-72">
                <p>这个体检只看三样东西——用词习惯、句子长短、节奏变化。它只是提醒你，不会拦着你写作，结果仅供参考。</p>
                <ul className="mt-1.5 list-inside list-disc space-y-1">
                  <li>句子长短太整齐 + 连接词多 + 感叹号少 → 像是模板套出来的</li>
                  <li>长短句错落 → 更像人写的</li>
                  <li>怀疑是 AI 写的时，可以到设置里加强你的文风要求</li>
                </ul>
              </InfoTip>
            </h2>
            <div className="flex items-center gap-2">
              <select
                className="rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
                value={chapterNo}
                onChange={(e) => setChapterNo(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">选择章节（取其正文）…</option>
                {chapters.map((c) => (
                  <option key={c.id} value={c.chapter_no}>
                    第{c.chapter_no}章 {c.title ?? ""}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-ghost"
                onClick={detectChapter}
                disabled={chapterNo === "" || loading}
              >
                取章检测
              </button>
              <button
                className="btn btn-primary"
                onClick={() => runDetect(text)}
                disabled={!text.trim() || loading}
              >
                {loading ? "检测中…" : "开始检测"}
              </button>
            </div>
          </div>
          <textarea
            className="min-h-0 w-full flex-1 resize-none rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            placeholder="粘贴一段文本（或选择章节后自动填充）…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </section>

        {/* ── 右：判定 / 模板词 / 句长统计 ─────────────────── */}
        <aside className="flex min-h-0 w-full flex-col gap-4 lg:h-full lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:pr-0.5">
          {result ? (
            <>
              <section className="panel flex flex-col gap-3">
                <div className="panel-head">
                  <h2 className="panel-title">判定</h2>
                  <span className="panel-hint">分数越高越像 AI 成稿</span>
                </div>
                <VerdictPie result={result} />
                <div className="grid grid-cols-2 gap-2.5">
                  <div className={`rounded-lg border p-3 ${VERDICT_STYLE[result.verdict]}`}>
                    <div className="text-xs opacity-70">结论</div>
                    <div className="mt-1 font-mono text-lg font-semibold">{VERDICT_LABEL[result.verdict]}</div>
                  </div>
                  <Stat label="综合得分" value={`${result.heuristic_score}/100`} accent />
                  <Stat label="文风反常度" value={result.ppl ?? "—"} />
                  <Stat label="长短句变化" value={result.burstiness ?? "—"} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {result.signals.map((s) => (
                    <span key={s} className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {s}
                    </span>
                  ))}
                  {result.signals.length === 0 && (
                    <span className="text-xs text-zinc-400">无显著信号</span>
                  )}
                </div>
                {result.note && <p className="text-xs text-zinc-500">{result.note}</p>}
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2 className="panel-title">模板词</h2>
                  <span className="panel-hint">模板痕迹</span>
                </div>
                {tplWords.length === 0 ? (
                  <p className="text-xs text-zinc-400">没发现模板痕迹</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {tplWords.map(([k, v]) => (
                      <li key={k} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-zinc-600 dark:text-zinc-300">{k}</span>
                        <span className="font-mono text-xs text-zinc-500">{v} 次</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2 className="panel-title">句长统计</h2>
                  <span className="panel-hint">句长与连接词</span>
                </div>
                {result.density ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">句数</span><span className="font-mono">{result.density.sentences}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">平均句长</span><span className="font-mono">{result.density.avg_sentence_len.toFixed(1)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">句子长短的整齐程度</span><span className="font-mono">{result.density.std_sentence_len.toFixed(1)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">短句比</span><span className="font-mono">{(result.density.short_ratio * 100).toFixed(0)}%</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">长句比</span><span className="font-mono">{(result.density.long_ratio * 100).toFixed(0)}%</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">逗号/句</span><span className="font-mono">{result.density.commas_per_sentence.toFixed(2)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">连接词密度</span><span className="font-mono">{result.density.transition_density.toFixed(2)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">感叹比</span><span className="font-mono">{(result.density.exclamation_ratio * 100).toFixed(0)}%</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">对话比</span><span className="font-mono">{(result.density.dialogue_ratio * 100).toFixed(0)}%</span></div>
                    <div className="flex justify-between text-sm"><span className="text-zinc-500">助词/连接词占比</span><span className="font-mono">{result.density.stopword_density.toFixed(2)}</span></div>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-400">没有统计数据</p>
                )}
              </section>
            </>
          ) : (
            <div className="panel text-sm text-zinc-500">
              先在左侧输入文本并开始检测，这里会展示结论饼图、模板词与句长统计。
            </div>
          )}
        </aside>
      </div>
    </Loading>
  );
}
