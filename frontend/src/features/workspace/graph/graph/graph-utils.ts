/**
 * @file graph/graph-utils.ts
 * 关系图谱面板的模块级纯函数、类型与常量（由 graph-panel.tsx 按逻辑边界拆分）：
 * - KIND_STYLE / ROLE_STYLE / ROLE_MARK：节点配色与身份字（势力紫、角色按主/重/次/灰分级）；
 * - relGroupKey / relCanonical / relEquivalent：同义关系归一化（仅展示层合并，不改动数据）；
 * - SimNode + layoutGraph：力导向布局（Fruchterman-Reingold，排斥 + 弹簧 + 中心引力 + 全局温度降温）；
 * - textWidth：按中/英字符宽度估算文本像素宽度（节点名与边标签共用，宽字符单位由调用方传入）；
 * - Rect：轴对齐矩形（世界坐标），供边标签与节点/已放置标签的碰撞检测复用。
 */
import type { GraphEdge, GraphNode } from "@/lib/api";

/* 节点配色：基础色为 mid-tone（深浅色通用），fill/text 用 color-mix 与主题感知的
   --paper / --ink-strong 混合，自动适配浅色与深色模式（无需为每主题另写一套色值）。
   基础色在 globals.css 的 :root 中定义（--g-character 等）。 */
const gStyle = (v: string) => ({
  fill: `color-mix(in oklab, ${v} 22%, var(--paper))`,
  stroke: v,
  text: `color-mix(in oklab, ${v} 82%, var(--ink-strong))`,
});
export const KIND_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  character: gStyle("var(--g-character)"),
  location: gStyle("var(--g-location)"),
  faction: gStyle("var(--g-faction)"),
  world_rule: gStyle("var(--g-world_rule)"),
  item: gStyle("var(--g-item)"),
  concept: gStyle("var(--g-concept)"),
  other: gStyle("var(--g-other)"),
};

/* 角色分级配色：主/重/次/灰 由身份字对应的等级决定，颜色一眼区分（复用上面的基础色） */
export const ROLE_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  protagonist: gStyle("var(--g-protagonist)"), // 主：朱砂红
  major: gStyle("var(--g-item)"), // 重：橙
  minor: gStyle("var(--g-character)"), // 次：蓝
  extra: gStyle("var(--g-other)"), // 灰：灰
};

/* 节点身份字：角色分级 / 势力（圆圈内显示）。覆盖全部等级，未知值兜底显示 */
export const ROLE_MARK: Record<string, string> = {
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
export const REL_SUFFIX_RE = /(关系|任职|身份|状态)$/;
export function relGroupKey(label: string): string {
  const s = label.replace(REL_SUFFIX_RE, "").replace(/\s+/g, "");
  return s || label;
}
export function relCanonical(labels: string[]): string {
  return labels.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}
export function relEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const ka = relGroupKey(a);
  const kb = relGroupKey(b);
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/* 力导向布局：Fruchterman-Reingold（排斥 + 弹簧 + 中心引力 + 全局温度降温）。
   理想边长 k 与画布尺寸解耦（约 4.5 倍节点直径，随节点数微增防拥挤），
   因此面板与全屏两种尺寸下世界坐标布局一致；慢冷却让仿真真正收敛到平衡，
   不会像早期版本那样冻结在半径 0.36×高的初始大圆环上导致节点相隔过远。 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], w: number, h: number): SimNode[] {
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

/** 估算文本像素宽度：按字符码位分中（宽）/英（窄）两类累加，宽字符单位由调用方传入。 */
export function textWidth(s: string, wide: number): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? wide : 6;
  return w;
}

/** 轴对齐矩形（世界坐标）：边标签与节点/已放置标签碰撞检测复用。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
