/**
 * @file graph-panel.tsx
 * 关系图谱面板：展示角色/势力的关系网络图，以及各角色的最新状态记忆回顾。
 * 核心机制：力导向布局（Fruchterman-Reingold）在纯前端计算节点坐标；
 * 同一对实体的多条关系合并为一条线展示（同义关系归一化，仅展示层合并），
 * 支持拖拽节点/平移/滚轮缩放/全屏，边标签做节点与标签双重防重叠。
 * 拆分说明：纯逻辑（布局/配色/关系归一化）在 graph/graph-utils.ts；
 * 交互图与空态容器在 graph/relation-graph.tsx（GraphCanvas 供面板/全屏共用）；
 * 图内边/节点/悬浮浮层在 graph/graph-edges.tsx 等；左栏记忆在 graph/memory-panel.tsx。
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getGraph, getMemoryReview, type GraphView, type MemoryReview } from "@/lib/api";
import { message } from "@/components/message";
import Loading from "@/components/loading";
import { MemoryPanel } from "./components/memory-panel";
import { GraphLegend } from "./components/graph-legend";
import { GraphCanvas } from "./components/relation-graph";

/**
 * 关系图谱面板主组件：并行加载图谱与角色状态回顾。
 * @param novelId 当前小说 id。
 */
export default function GraphPanel({ novelId }: { novelId: string }) {
  const [graph, setGraph] = useState<GraphView>({ nodes: [], edges: [] });
  const [memory, setMemory] = useState<MemoryReview | null>(null);
  const [loading, setLoading] = useState(true);
  /** 是否全屏展示图谱（全屏时只留关闭按钮） */
  const [fullscreen, setFullscreen] = useState(false);

  /* 图谱只展示角色与势力；两端均为这两类的边才显示，避免悬空线。
     没有任何可见关联边的孤立实体不显示（无连接，单独展示没有意义） */
  const visible = useMemo(() => {
    const showKinds = new Set(["character", "faction"]);
    const nodes = graph.nodes.filter((n) => showKinds.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const connectedIds = new Set<string>();
    for (const e of edges) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
    return { nodes: nodes.filter((n) => connectedIds.has(n.id)), edges };
  }, [graph]);

  /** 并行加载关系图与角色状态记忆；任一失败仅弹错误提示，不阻塞另一份数据。 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, m] = await Promise.all([getGraph(novelId), getMemoryReview(novelId)]);
      setGraph(g);
      setMemory(m);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Loading loading={loading} className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-0 w-full flex-1 items-stretch gap-6">
      {/* 左：角色状态 */}
      {memory && <MemoryPanel memory={memory} />}

      {/* 右：关系图谱（交互网络图） */}
      <section className="panel flex min-h-0 flex-1 flex-col gap-3.5">
        <div className="panel-head mb-0 shrink-0">
          <h2 className="panel-title">
            人物关系图
            <GraphLegend />
            <span className="text-xs font-normal text-zinc-500">
              {visible.edges.length} 对关系 · {visible.nodes.length} 个人/势力
            </span>
          </h2>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              title="全屏查看人物关系"
              aria-label="全屏查看人物关系"
              className="grid h-6 w-6 place-items-center rounded-md border border-zinc-200 text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </button>
          </span>
        </div>

        <GraphCanvas
          className="min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
          nodes={visible.nodes}
          edges={visible.edges}
        />
      </section>
    </div>

    {/* 全屏图谱：仅一个 X 关闭，支持拖拽/平移/滚轮缩放 */}
    {fullscreen && (
      <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950">
        <div className="flex shrink-0 items-center justify-end px-4 py-3">
          <button
            type="button"
            onClick={() => setFullscreen(false)}
            title="关闭全屏"
            aria-label="关闭全屏"
            className="grid h-8 w-8 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <GraphCanvas className="min-h-0 flex-1" nodes={visible.nodes} edges={visible.edges} />
      </div>
    )}
    </Loading>
  );
}
