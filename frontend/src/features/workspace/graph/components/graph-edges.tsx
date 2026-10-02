/**
 * @file graph/graph-edges.tsx
 * 关系图边渲染（纯展示，由 relation-graph.tsx 拆出）：
 * 同一对实体的多条关系合并成一条二次贝塞尔线（同义关系归一化后多行标签），
 * 箭头按方向区分单向/双向，低置信度虚线；标签位置沿法线逐级推远做双重防重叠。
 * props 全部为只读数据/坐标，不持有任何状态（placedLabels 每次渲染重建，仅边内部使用）。
 */
"use client";

import type { GraphEdge } from "@/lib/api";
import { relCanonical, relEquivalent, textWidth, type Rect } from "./graph-utils";

/** 边渲染：合并关系成线 + 多行标签 + 防重叠。 */
export function GraphEdges({
  pairMap,
  pos,
  view,
  nodeRects,
}: {
  pairMap: Map<string, GraphEdge[]>;
  pos: Record<string, { x: number; y: number }>;
  view: { x: number; y: number; k: number };
  nodeRects: Rect[];
}) {
  /* 已放置的边标签矩形，用于标签间防重叠（每次渲染重建） */
  const placedLabels: Rect[] = [];

  return (
    <>
      {/* 边：同一对实体合并成一条线，标签只列出各关系名；章节详情悬浮节点查看 */}
      {[...pairMap.entries()].map(([key, rows]) => {
        const [sName, tName] = key.split("\u0000");
        const s = pos[sName];
        const t = pos[tName];
        if (!s || !t) return null;
        /* 路径缩短到节点圆外（r=16 + 空隙），让箭头完整露出、不被圆盖住 */
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const D = Math.max(0, Math.min(24, len / 2 - 2));
        const ax = s.x + ux * D;
        const ay = s.y + uy * D;
        const bx = t.x - ux * D;
        const by = t.y - uy * D;
        const mdx = bx - ax;
        const mdy = by - ay;
        const mlen = Math.hypot(mdx, mdy) || 1;
        const nx = -mdy / mlen;
        const ny = mdx / mlen;
        const amx = (ax + bx) / 2;
        const amy = (ay + by) / 2;
        const cx = amx + nx * 8;
        const cy = amy + ny * 8;
        /* 方向：单向给单箭头，双向给两端箭头 */
        const hasAB = rows.some((e) => e.source === sName && e.target === tName);
        const hasBA = rows.some((e) => e.source === tName && e.target === sName);
        /* 多行标签：同义关系合并分组（如「入职」与「入职任职」），每行只显示关系名（不显示章节） */
        const relLines: Array<{ label: string; rows: GraphEdge[] }> = [];
        for (const e of rows) {
          let cls = relLines.find((l) => relEquivalent(l.label, e.label));
          if (!cls) {
            cls = { label: e.label, rows: [] };
            relLines.push(cls);
          }
          cls.rows.push(e);
        }
        for (const cls of relLines) cls.label = relCanonical(cls.rows.map((r) => r.label));
        const lines = relLines.map((l) => l.label);
        /* 标签位置：优先放线正中间；与节点或已放置标签碰撞时沿两侧法线逐级推远 */
        const labelW = Math.max(...lines.map((ln) => textWidth(ln, 10))) + 8;
        const labelH = lines.length * 12 + 2;
        /* 二次贝塞尔 t=0.5 处真正的曲线中点 */
        const midX = amx + nx * 4;
        const midY = amy + ny * 4;
        const hitAny = (px: number, py: number) =>
          nodeRects.some(
            (rr) => Math.abs(px - rr.x) < (labelW + rr.w) / 2 && Math.abs(py - rr.y) < (labelH + rr.h) / 2
          ) ||
          placedLabels.some(
            (lr) => Math.abs(px - lr.x) < (labelW + lr.w) / 2 && Math.abs(py - lr.y) < (labelH + lr.h) / 2
          );
        let lxC = midX;
        let lyC = midY;
        for (let k = 0; k < 40 && hitAny(lxC, lyC); k++) {
          const dist = (Math.floor(k / 2) + 1) * 12;
          const dir = k % 2 === 0 ? 1 : -1;
          lxC = midX + nx * dist * dir;
          lyC = midY + ny * dist * dir;
        }
        const lx = lxC;
        const ly = lyC - labelH / 2 + 7;
        placedLabels.push({ x: lxC, y: lyC, w: labelW, h: labelH });
        const tooltip = relLines
          .map((l) => l.rows.map((e) => `${e.source} —${l.label}→ ${e.target}（第${e.chapter_no ?? "?"}章确立）`).join("；"))
          .join("；");
        return (
          <g key={key}>
            <path
              d={`M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray={rows.some((e) => e.confidence === "low") ? "4 3" : undefined}
              markerEnd={hasAB ? "url(#rel-arrow)" : undefined}
              markerStart={hasBA ? "url(#rel-arrow-rev)" : undefined}
            >
              <title>{tooltip}</title>
            </path>
            <text
              x={lx}
              y={ly}
              textAnchor="middle"
              fontSize={10}
              style={{ fill: "currentColor", stroke: "var(--paper)", strokeWidth: 3, paintOrder: "stroke" }}
              className="pointer-events-none select-none"
            >
              {lines.map((ln, i) => (
                <tspan key={ln} x={lx} dy={i === 0 ? 0 : 12}>
                  {ln}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </>
  );
}
