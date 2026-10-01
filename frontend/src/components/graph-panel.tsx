/**
 * @file graph-panel.tsx
 * 关系图谱面板：展示角色/势力的关系网络图，以及各角色的最新状态记忆回顾。
 * 核心机制：力导向布局（Fruchterman-Reingold）在纯前端计算节点坐标；
 * 同一对实体的多条关系合并为一条线展示（同义关系归一化，仅展示层合并），
 * 支持拖拽节点/平移/滚轮缩放/全屏，边标签做节点与标签双重防重叠。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGraph, getMemoryReview, type GraphEdge, type GraphNode, type GraphView, type MemoryReview } from "@/lib/api";
import { message } from "@/components/message";
import Loading from "@/components/loading";

/* 节点配色：基础色为 mid-tone（深浅色通用），fill/text 用 color-mix 与主题感知的
   --paper / --ink-strong 混合，自动适配浅色与深色模式（无需为每主题另写一套色值）。
   基础色在 globals.css 的 :root 中定义（--g-character 等）。 */
const gStyle = (v: string) => ({
  fill: `color-mix(in oklab, ${v} 22%, var(--paper))`,
  stroke: v,
  text: `color-mix(in oklab, ${v} 82%, var(--ink-strong))`,
});
const KIND_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  character: gStyle("var(--g-character)"),
  location: gStyle("var(--g-location)"),
  faction: gStyle("var(--g-faction)"),
  world_rule: gStyle("var(--g-world_rule)"),
  item: gStyle("var(--g-item)"),
  concept: gStyle("var(--g-concept)"),
  other: gStyle("var(--g-other)"),
};

/* 角色分级配色：主/重/次/灰 由身份字对应的等级决定，颜色一眼区分（复用上面的基础色） */
const ROLE_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  protagonist: gStyle("var(--g-protagonist)"), // 主：朱砂红
  major: gStyle("var(--g-item)"), // 重：橙
  minor: gStyle("var(--g-character)"), // 次：蓝
  extra: gStyle("var(--g-other)"), // 灰：灰
};

/* 节点身份字：角色分级 / 势力（圆圈内显示）。覆盖全部等级，未知值兜底显示 */
const ROLE_MARK: Record<string, string> = {
  protagonist: "主",
  major: "重",
  minor: "次",
  extra: "灰",
};

/* 同义关系归一化（仅展示层合并，不改动数据）：
   同一对实体间语义相同的关系合并为一行展示，例如「入职」与「入职任职」。
   - 分组键：去掉常见语义后缀（关系/任职/身份/状态）后的规范名；
   - 同义判定：分组键相同，或一方是另一方的子串（覆盖后缀规则之外的变体）；
   - 展示名：取类内最短的原始标签，避免把本就唯一的标签改写成缩写。 */
const REL_SUFFIX_RE = /(关系|任职|身份|状态)$/;
function relGroupKey(label: string): string {
  const s = label.replace(REL_SUFFIX_RE, "").replace(/\s+/g, "");
  return s || label;
}
function relCanonical(labels: string[]): string {
  return labels.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}
function relEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const ka = relGroupKey(a);
  const kb = relGroupKey(b);
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/* 力导向布局：Fruchterman-Reingold（排斥 + 弹簧 + 中心引力 + 全局温度降温）。
   理想边长 k 与画布尺寸解耦（约 4.5 倍节点直径，随节点数微增防拥挤），
   因此面板与全屏两种尺寸下世界坐标布局一致；慢冷却让仿真真正收敛到平衡，
   不会像早期版本那样冻结在半径 0.36×高的初始大圆环上导致节点相隔过远。 */
function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], w: number, h: number): SimNode[] {
  const sim: SimNode[] = nodes.map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0 }));
  const n = sim.length;
  if (n === 0) return sim;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.18; // 初始圆环半径：小起步，靠力场收敛到平衡
  sim.forEach((nd, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    nd.x = cx + Math.cos(a) * R;
    nd.y = cy + Math.sin(a) * R;
  });
  const byId = new Map(sim.map((nd) => [nd.id, nd]));
  const k = Math.max(60, Math.min(100, 72 + n * 0.3)); // 理想边长：与画布无关，避免大画布把图撑散
  const maxIter = 500;
  let temp = Math.min(w, h) * 0.09;
  const tempMin = 0.5;
  for (let it = 0; it < maxIter; it++) {
    const disp = new Map<string, { x: number; y: number }>();
    sim.forEach((nd) => disp.set(nd.id, { x: 0, y: 0 }));
    /* 排斥：所有节点两两相斥（越近越强） */
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = sim[i];
        const b = sim[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.01) d = 0.01;
        const f = (k * k) / d;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const da = disp.get(a.id)!;
        const db = disp.get(b.id)!;
        da.x += fx;
        da.y += fy;
        db.x -= fx;
        db.y -= fy;
      }
    }
    /* 弹簧：有关系的节点相互拉近 */
    for (const e of edges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / k;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      const ds = disp.get(s.id)!;
      const dt = disp.get(t.id)!;
      ds.x += fx;
      ds.y += fy;
      dt.x -= fx;
      dt.y -= fy;
    }
    /* 中心引力：把孤立/不连通节点拽回中心附近，防止被斥力推到画布边缘 */
    for (const nd of sim) {
      const d = disp.get(nd.id)!;
      d.x += (cx - nd.x) * 0.06;
      d.y += (cy - nd.y) * 0.06;
    }
    /* 按温度限制单步位移，温度逐步降低使布局收敛稳定 */
    for (const nd of sim) {
      const d = disp.get(nd.id)!;
      const m = Math.hypot(d.x, d.y) || 1;
      const step = Math.min(temp, m);
      nd.x += (d.x / m) * step;
      nd.y += (d.y / m) * step;
    }
    temp = Math.max(tempMin, temp * 0.97);
  }
  return sim;
}

/** 交互式关系图：负责布局、渲染、拖拽/平移/缩放与边标签防重叠。 */
function RelationGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
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
        let nameW = 0;
        for (const ch of nd.label) nameW += ch.charCodeAt(0) > 255 ? 11 : 6;
        nameW += 6;
        const minX = Math.min(p.x - R, p.x - nameW / 2);
        const maxX = Math.max(p.x + R, p.x + nameW / 2);
        const minY = Math.min(p.y - R, p.y + R + 13 - 10);
        const maxY = Math.max(p.y + R, p.y + R + 13 + 4);
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
      })
      .filter((v): v is { x: number; y: number; w: number; h: number } => v != null);
  }, [nodes, pos]);

  /* 已放置的边标签矩形，用于标签间防重叠（每次渲染重建） */
  const placedLabels: Array<{ x: number; y: number; w: number; h: number }> = [];

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
            const textW = (s: string) => {
              let w = 0;
              for (const ch of s) w += ch.charCodeAt(0) > 255 ? 10 : 6;
              return w;
            };
            const labelW = Math.max(...lines.map(textW)) + 8;
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

          {/* 节点 */}
          {nodes.map((nd) => {
            const p = pos[nd.id];
            if (!p) return null;
            /* 角色按分级配色（主/重/次/灰），势力用紫色，未知等级回退角色蓝 */
            const style =
              nd.kind === "faction"
                ? KIND_STYLE.faction
                : (ROLE_STYLE[nd.role_rank ?? ""] ?? KIND_STYLE.character);
            const r = 16; // 所有节点圆统一大小
            const mark =
              nd.kind === "faction"
                ? "势"
                : ROLE_MARK[nd.role_rank ?? ""] ?? (nd.role_rank ? nd.role_rank[0].toUpperCase() : "");
            return (
              <g
                key={nd.id}
                data-node={nd.id}
                className="cursor-pointer"
                onPointerEnter={() => setHoverNode(nd)}
                onPointerLeave={() => setHoverNode((h) => (h && h.id === nd.id ? null : h))}
                onPointerDown={() => setHoverNode(null)}
              >
                <circle cx={p.x} cy={p.y} r={r} style={{ fill: style.fill, stroke: style.stroke }} strokeWidth={1.6} />
                {mark && (
                  <text
                    x={p.x}
                    y={p.y + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={700}
                    style={{ fill: style.text }}
                    className="pointer-events-none select-none"
                  >
                    {mark}
                  </text>
                )}
                <text
                  x={p.x}
                  y={p.y + r + 13}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={600}
                  style={{ fill: style.text, stroke: "var(--paper)", strokeWidth: 3, paintOrder: "stroke" }}
                  className="pointer-events-none select-none"
                >
                  {nd.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* 节点悬浮详情：显示该节点全部关系，每行「A —关系→ B（第X章确立）」；点击拖拽时关闭 */}
      {hoverNode &&
        (() => {
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
        })()}

      <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-zinc-100/90 px-1.5 py-0.5 text-[10px] text-zinc-400 dark:bg-zinc-900/90 dark:text-zinc-500">
        拖拽圆点/拖空白处移动 · 滚轮放大缩小 · 鼠标放圆点上查看关系
      </span>
    </div>
  );
}

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
    <Loading loading={loading}>
    <div className="flex h-[calc(100dvh-6rem)] w-full items-stretch gap-6">
      {/* 左：角色状态 */}
      {memory && (
        <section className="panel flex w-[min(24rem,40%)] shrink-0 flex-col">
          <div className="panel-head shrink-0">
            <h2 className="panel-title">
              角色状态
              <span className="text-xs font-normal text-zinc-500">
                {Object.keys(memory.character_states).length} 个角色
              </span>
            </h2>
            <span className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  memory.healthy ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
                }`}
              >
                {memory.healthy ? "健康" : "需关注"}
              </span>
              <span className="panel-hint">进度：第 {memory.progress_chapter} 章</span>
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            {Object.keys(memory.character_states).length === 0 ? (
              memory.progress_chapter > 0 ? (
                <p className="text-xs text-zinc-400">还缺角色状态。写完章节后点『记进 AI 记忆』重新提取一次即可</p>
              ) : (
                <p className="text-xs text-zinc-400">还没有章节。写完章节后，AI 会自动整理出每个角色当前的状态</p>
              )
            ) : (
              <ul className="flex flex-col gap-2">
                {Object.entries(memory.character_states).map(([name, st]) => (
                  <li key={name} className="flex gap-2 text-xs">
                    <span className="w-20 shrink-0 break-words font-medium leading-5 text-zinc-500 dark:text-zinc-400">{name}</span>
                    <span className="min-w-0 flex-1 break-words font-semibold leading-5 text-zinc-800 dark:text-zinc-200">
                      {st.state}
                      <span className="font-normal text-zinc-400 dark:text-zinc-500"> · 第{st.chapter_no}章</span>
                      {st.confidence === "low" && (
                        <span className="ml-1.5 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300">存疑</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {memory.issues.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <span className="font-semibold">问题清单：</span>
                {memory.issues.join("；")}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 右：关系图谱（交互网络图） */}
      <section className="panel flex min-h-0 flex-1 flex-col gap-3.5">
        <div className="panel-head mb-0 shrink-0">
          <h2 className="panel-title">
            人物关系图
            <span className="group relative inline-flex items-center">
              <span
                aria-label="人物关系图说明"
                className="grid h-4 w-4 cursor-help place-items-center rounded-full border border-zinc-300 text-[10px] font-semibold text-zinc-400 hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-zinc-500 dark:hover:text-zinc-300"
              >
                ?
              </span>
              <span className="invisible absolute left-0 top-full z-30 mt-1.5 w-80 rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-relaxed text-zinc-700 opacity-0 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                <p>
                  每章写完后自动整理人物关系。两人之间多条关系会合并显示，鼠标放到线上可看详情；过时的关系自动隐藏。
                </p>
                <div className="mt-2.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  <p className="mb-1.5 font-medium text-zinc-800 dark:text-zinc-100">圆点上的身份字</p>
                  <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {(
                      [
                        ["主", "主角", "protagonist"],
                        ["重", "重要配角", "major"],
                        ["次", "次要配角", "minor"],
                        ["灰", "龙套/炮灰", "extra"],
                        ["势", "势力", "faction"],
                      ] as [string, string, string][]
                    ).map(([mark, name, key]) => {
                      const s = (ROLE_STYLE as Record<string, { fill: string; stroke: string; text: string }>)[key] ?? KIND_STYLE[key];
                      return (
                      <li key={mark} className="flex items-center gap-1.5">
                        <span
                          className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none"
                          style={{ background: s.fill, color: s.text, border: `1px solid ${s.stroke}` }}
                        >
                          {mark}
                        </span>
                        {name}
                      </li>
                      );
                    })}
                  </ul>
                </div>
              </span>
            </span>
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

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          {visible.edges.length === 0 ? (
            <div className="grid h-full place-items-center text-xs text-zinc-400">
              还没有关系图。写完章节后由 AI 自动生成
            </div>
          ) : (
            <RelationGraph nodes={visible.nodes} edges={visible.edges} />
          )}
        </div>
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
        <div className="min-h-0 flex-1">
          {visible.edges.length === 0 ? (
            <div className="grid h-full place-items-center text-xs text-zinc-400">
              还没有关系图。写完章节后由 AI 自动生成
            </div>
          ) : (
            <RelationGraph nodes={visible.nodes} edges={visible.edges} />
          )}
        </div>
      </div>
    )}
    </Loading>
  );
}
