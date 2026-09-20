"use client";

import { useCallback, useEffect, useState } from "react";
import { detectText, listChapters, type ChapterListItem, type DetectResult } from "@/lib/api";
import { message } from "@/components/message";
import Loading from "@/components/loading";

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

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-lg">{value}</div>
    </div>
  );
}

export default function DetectPanel({ novelId }: { novelId: string }) {
  const [chapters, setChapters] = useState<ChapterListItem[]>([]);
  const [text, setText] = useState("");
  const [chapterNo, setChapterNo] = useState<number | "">("");
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

  const detectChapter = async () => {
    if (chapterNo === "") return;
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
    <Loading loading={chaptersLoading}>
      <div className="grid w-full gap-6 lg:grid-cols-[1fr_360px]">
      <div className="flex min-w-0 flex-col gap-5 sm:gap-7">
        <section className="panel flex flex-col gap-2.5">
          <div className="panel-head">
            <h2 className="panel-title">
              <span className="panel-step">1</span>
              体检文本
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
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                onClick={detectChapter}
                disabled={chapterNo === "" || loading}
              >
                取章检测
              </button>
              <button
                className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                onClick={() => runDetect(text)}
                disabled={!text.trim() || loading}
              >
                {loading ? "检测中…" : "开始检测"}
              </button>
            </div>
          </div>
          <textarea
            className="h-64 w-full resize-y rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            placeholder="粘贴一段文本（或选择章节后自动填充）…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </section>

        {result && (
          <>
            <section className="panel flex flex-col gap-2.5">
              <div className="panel-head">
                <h2 className="panel-title">
                  <span className="panel-step">2</span>
                  判定
                </h2>
                <span className="panel-hint">分数越高越像 AI 成稿</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className={`rounded-lg border p-3 ${VERDICT_STYLE[result.verdict]}`}>
                  <div className="text-xs opacity-70">结论</div>
                  <div className="mt-1 font-mono text-lg font-semibold">{VERDICT_LABEL[result.verdict]}</div>
                </div>
                <Stat label="综合得分" value={`${result.heuristic_score}/100`} accent />
                <Stat label="困惑度 PPL" value={result.ppl ?? "—"} />
                <Stat label="突发性 Burstiness" value={result.burstiness ?? "—"} />
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

            <section className="grid gap-4 md:grid-cols-2">
              <div className="panel">
                <div className="panel-head">
                  <h2 className="panel-title">
                    <span className="panel-step">3</span>
                    词法命中
                  </h2>
                  <span className="panel-hint">regex · 模板痕迹</span>
                </div>
                  {Object.entries(result.regex_hits).length === 0 ? (
                    <p className="text-xs text-zinc-400">无命中</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {Object.entries(result.regex_hits).map(([k, v]) => (
                        <li key={k} className="flex items-center justify-between text-sm">
                          <span className="text-zinc-600 dark:text-zinc-300">{k}</span>
                          <span className="font-mono text-xs">{v} 次</span>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h2 className="panel-title">
                    <span className="panel-step">4</span>
                    密度指纹
                  </h2>
                  <span className="panel-hint">density · 句长与连接词</span>
                </div>
                  {result.density ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">句数</span><span className="font-mono">{result.density.sentences}</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">平均句长</span><span className="font-mono">{result.density.avg_sentence_len.toFixed(1)}</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">句长标准差</span><span className="font-mono">{result.density.std_sentence_len.toFixed(1)}</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">短句比</span><span className="font-mono">{(result.density.short_ratio * 100).toFixed(0)}%</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">长句比</span><span className="font-mono">{(result.density.long_ratio * 100).toFixed(0)}%</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">逗号/句</span><span className="font-mono">{result.density.commas_per_sentence.toFixed(2)}</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">连接词密度</span><span className="font-mono">{result.density.transition_density.toFixed(2)}</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">感叹比</span><span className="font-mono">{(result.density.exclamation_ratio * 100).toFixed(0)}%</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">对话比</span><span className="font-mono">{(result.density.dialogue_ratio * 100).toFixed(0)}%</span></div>
                      <div className="flex justify-between text-sm"><span className="text-zinc-500">虚词密度</span><span className="font-mono">{result.density.stopword_density.toFixed(2)}</span></div>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-400">无密度数据</p>
                  )}
              </div>
            </section>
          </>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <div className="panel text-sm">
          <div className="panel-head">
            <h3 className="panel-title">说明</h3>
          </div>
          <p className="text-zinc-500">本检测为三层信号参考（词法规则 / 密度指纹 / 突发性启发式），不设硬阈值、不阻断写作，仅作提示。</p>
        </div>
        <div className="panel text-sm">
          <div className="panel-head">
            <h3 className="panel-title">判读提示</h3>
          </div>
          <ul className="list-inside list-disc space-y-1 text-zinc-500">
            <li>句长标准差小 + 连接词密集 + 感叹比低 → 偏模板化</li>
            <li>突发性高（长短句交替）→ 更接近人类书写节奏</li>
            <li>「疑似 AI」时优先在写作指令 L1 中加强风格约束</li>
          </ul>
        </div>
      </aside>
      </div>
    </Loading>
  );
}
