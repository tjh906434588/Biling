/**
 * @file graph/graph-nodes.tsx
 * 关系图节点渲染（纯展示，由 relation-graph.tsx 拆出）：
 * 圆 + 身份字（势力显示「势」，角色按分级主/重/次/灰）+ 名称；
 * 悬浮/离开/按下通过 setHoverNode 回调通知父组件维护悬浮态（点击拖拽时关闭浮层）。
 */
"use client";

import type { Dispatch, SetStateAction } from "react";
import type { GraphNode } from "@/lib/api";
import { KIND_STYLE, ROLE_MARK, ROLE_STYLE } from "./graph-utils";

/** 节点渲染：全部节点圆圈 + 身份字 + 名称，交互仅回调悬浮状态。 */
export function GraphNodes({
  nodes,
  pos,
  setHoverNode,
}: {
  nodes: GraphNode[];
  pos: Record<string, { x: number; y: number }>;
  setHoverNode: Dispatch<SetStateAction<GraphNode | null>>;
}) {
  return (
    <>
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
    </>
  );
}
