/**
 * @file graph/hover-tooltip.tsx
 * 节点悬浮详情浮层（纯展示，由 relation-graph.tsx 拆出）：
 * 显示该节点全部关系，每行「A —关系→ B（第X章确立）」；
 * 同义关系合并、按最早确立章节排序；靠近底部时自动翻转在节点上方显示。
 * 父组件保证 hoverNode 非空才渲染本组件。
 */
"use client";

import type { GraphEdge, GraphNode } from "@/lib/api";
import { relCanonical, relGroupKey } from "./graph-utils";

/** 悬浮详情浮层：节点标签 + 各关系行，纯展示。 */
export function HoverTooltip({
  hoverNode,
  pos,
  view,
  size,
  edges,
}: {
  hoverNode: GraphNode;
  pos: Record<string, { x: number; y: number }>;
  view: { x: number; y: number; k: number };
  size: { w: number; h: number };
  edges: GraphEdge[];
}) {
  const hp = pos[hoverNode.id];
  if (!hp) return null;
  const byTriple = new Map<string, { src: string; dst: string; labels: string[]; chapters: number[] }>();
  for (const e of edges) {
    if (e.source !== hoverNode.id && e.target !== hoverNode.id) continue;
    const key = `${e.source}\u0000${relGroupKey(e.label)}\u0000${e.target}`;
    const rec = byTriple.get(key) ?? { src: e.source, dst: e.target, labels: [], chapters: [] as number[] };
    rec.labels.push(e.label);
    if (e.chapter_no != null) rec.chapters.push(e.chapter_no);
    byTriple.set(key, rec);
  }
  const lines = [...byTriple.values()]
    .sort((a, b) => (a.chapters[0] ?? Infinity) - (b.chapters[0] ?? Infinity))
    .map((r) => {
      const label = relCanonical(r.labels);
      const uniq = Array.from(new Set(r.chapters)).sort((x, y) => x - y);
      return `${r.src} —${label}→ ${r.dst}` + (uniq.length > 0 ? `（第${uniq.join("、")}章确立）` : "");
    });
  if (lines.length === 0) return null;
  const sx = view.x + hp.x * view.k;
  const sy = view.y + hp.y * view.k;
  const above = sy > size.h - 180;
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-72 rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-[11px] leading-relaxed text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      style={{
        left: Math.min(Math.max(sx, 110), size.w - 110),
        top: above ? sy - 12 : sy + 40,
        transform: above ? "translate(-50%, -100%)" : "translateX(-50%)",
      }}
    >
      <div className="mb-1 border-b border-zinc-100 pb-1 font-semibold text-zinc-800 dark:border-zinc-800 dark:text-zinc-100">
        {hoverNode.label}
      </div>
      {lines.map((ln) => (
        <div key={ln}>{ln}</div>
      ))}
    </div>
  );
}
