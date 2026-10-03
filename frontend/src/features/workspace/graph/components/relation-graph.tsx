/**
 * @file graph/relation-graph.tsx
 * 交互式关系图：力导向布局 + 节点/边渲染 + 拖拽/平移/滚轮缩放/视口自适应。
 * 由 graph-panel.tsx 拆出：布局计算与全部交互状态（尺寸、坐标、视图变换、
 * 悬浮/拖拽/平移）保留在本组件；边、节点、悬浮浮层分别委托
 * GraphEdges / GraphNodes / HoverTooltip 渲染，纯逻辑见 graph-utils.ts。
 * 另导出 GraphCanvas：关系图空态/有图容器（面板与全屏两处共用）。
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "@/lib/api";
import { layoutGraph, textWidth, type Rect } from "./graph-utils";
import { GraphEdges } from "./graph-edges";
import { GraphNodes } from "./graph-nodes";
import { HoverTooltip } from "./hover-tooltip";

/** 交互式关系图：负责布局、渲染、拖拽/平移/缩放与边标签防重叠。 */
export function RelationGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** 节点 id → 世界坐标（力导向布局产出，拖拽节点时手动更新） */
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  /** 视图变换：平移 (x,y) + 缩放 k，把世界坐标映射到屏幕 */
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  /** 当前悬浮的节点，驱动其关系详情的浮层展示 */
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
  /** 正在拖拽的节点 id；null = 未在拖拽 */
  const drag = useRef<{ id: string } | null>(null);
  /** 空白处平移的起点记录（按下时的指针坐标 + 当时的视图偏移），用于计算增量平移 */
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  /* 测量容器尺寸（1:1 像素坐标，屏幕/世界坐标换算简单） */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* 数据变化时重新布局并自动适配视口 */
  useEffect(() => {
    if (size.w <= 0 || size.h <= 0) return;
    const laid = layoutGraph(nodes, edges, size.w, size.h);
    const posMap: Record<string, { x: number; y: number }> = {};
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const nd of laid) {
      posMap[nd.id] = { x: nd.x, y: nd.y };
      const m = 34; // 节点+标签留白
      minX = Math.min(minX, nd.x - m);
      minY = Math.min(minY, nd.y - m);
      maxX = Math.max(maxX, nd.x + m);
      maxY = Math.max(maxY, nd.y + m);
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = Math.min(1.5, Math.min(size.w / bw, size.h / bh));
    setPos(posMap);
    setView({
      x: (size.w - bw * k) / 2 - minX * k,
      y: (size.h - bh * k) / 2 - minY * k,
      k,
    });
  }, [nodes, edges, size.w, size.h]);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** 按下：命中节点则开始拖节点，否则开始平移空白处；均捕获指针以便连续跟踪。 */
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toLocal(e);
    const nodeId = (e.target as Element).closest("[data-node]")?.getAttribute("data-node");
    if (nodeId) {
      drag.current = { id: nodeId };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      pan.current = { sx: p.x, sy: p.y, ox: view.x, oy: view.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toLocal(e);
    if (drag.current) {
      const id = drag.current.id;
      const wx = (p.x - view.x) / view.k;
      const wy = (p.y - view.y) / view.k;
      setPos((prev) => ({ ...prev, [id]: { x: wx, y: wy } }));
    } else if (pan.current) {
      const { sx, sy, ox, oy } = pan.current;
      setView((v) => ({ ...v, x: ox + (p.x - sx), y: oy + (p.y - sy) }));
    }
  };

  const endDrag = () => {
    drag.current = null;
    pan.current = null;
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const p = toLocal(e);
    // 以指针位置为锚点缩放（每次 ±10%，范围 0.25x–3x），保证缩放中心不漂移
    setView((v) => {
      const k2 = Math.min(3, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      return { x: p.x - ((p.x - v.x) / v.k) * k2, y: p.y - ((p.y - v.y) / v.k) * k2, k: k2 };
    });
  };

  /* 同一对实体的所有关系合并成一条线（仅展示层合并）：
     按无向实体对分组，标签多行列出各关系及确立章节 */
  const pairMap = useMemo(() => {
    const m = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = e.source < e.target ? `${e.source}\u0000${e.target}` : `${e.target}\u0000${e.source}`;
      const arr = m.get(key) ?? [];
      arr.push(e);
      m.set(key, arr);
    }
    return m;
  }, [edges]);

  /* 节点阻挡矩形（圆 + 下方名称），用于边标签防重叠 */
  const nodeRects = useMemo(() => {
    const R = 16;
    return nodes
      .map((nd) => {
        const p = pos[nd.id];
        if (!p) return null;
        const nameW = textWidth(nd.label, 11) + 6;
        const minX = Math.min(p.x - R, p.x - nameW / 2);
        const maxX = Math.max(p.x + R, p.x + nameW / 2);
        const minY = Math.min(p.y - R, p.y + R + 13 - 10);
        const maxY = Math.max(p.y + R, p.y + R + 13 + 4);
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
      })
      .filter((v): v is Rect => v != null);
  }, [nodes, pos]);

  return (
    <div ref={boxRef} className="relative h-full w-full overflow-hidden">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="block cursor-grab text-zinc-400 active:cursor-grabbing dark:text-zinc-600"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        <defs>
          {/* 箭头 marker（userSpaceOnUse 按图坐标固定大小，14px 保证清晰可见；双 marker 避免 auto-start-reverse 兼容问题） */}
          <marker id="rel-arrow" viewBox="0 0 14 14" refX="12" refY="7" markerWidth="14" markerHeight="14" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M3,3 L13,7 L3,11 z" style={{ fill: "var(--zinc-500)" }} />
          </marker>
          <marker id="rel-arrow-rev" viewBox="0 0 14 14" refX="2" refY="7" markerWidth="14" markerHeight="14" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M11,3 L1,7 L11,11 z" style={{ fill: "var(--zinc-500)" }} />
          </marker>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <GraphEdges pairMap={pairMap} pos={pos} nodeRects={nodeRects} />
          <GraphNodes nodes={nodes} pos={pos} setHoverNode={setHoverNode} />
        </g>
      </svg>

      {/* 节点悬浮详情：显示该节点全部关系，每行「A —关系→ B（第X章确立）」；点击拖拽时关闭 */}
      {hoverNode && <HoverTooltip hoverNode={hoverNode} pos={pos} view={view} size={size} edges={edges} />}

      <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-zinc-100/90 px-1.5 py-0.5 text-[10px] text-zinc-400 dark:bg-zinc-900/90 dark:text-zinc-500">
        拖拽圆点/拖空白处移动 · 滚轮放大缩小 · 鼠标放圆点上查看关系
      </span>
    </div>
  );
}

/** 关系图容器：空态提示 / 交互图，面板与全屏两处共用（外层类名由调用方传入）。 */
export function GraphCanvas({
  className,
  nodes,
  edges,
}: {
  className: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}) {
  return (
    <div className={className}>
      {edges.length === 0 ? (
        <div className="grid h-full place-items-center text-xs text-zinc-400">
          还没有关系图。写完章节后由 AI 自动生成
        </div>
      ) : (
        <RelationGraph nodes={nodes} edges={edges} />
      )}
    </div>
  );
}
