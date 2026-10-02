/**
 * @file lib/api/graph.ts
 * 实体图谱 + 记忆审查接口（/novels/{id}/graph、/memory-review）。
 */
import { BASE } from "@/constants/api";
import type { GraphView, MemoryReview } from "@/types/api";

export async function getGraph(novelId: string): Promise<GraphView> {
  const res = await fetch(`${BASE}/novels/${novelId}/graph`);
  if (!res.ok) throw new Error("加载图谱失败");
  return res.json();
}

export async function getMemoryReview(novelId: string): Promise<MemoryReview> {
  const res = await fetch(`${BASE}/novels/${novelId}/memory-review`);
  if (!res.ok) throw new Error("加载记忆审查失败");
  return res.json();
}
