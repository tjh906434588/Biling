/**
 * @file lib/api/novels.ts
 * 书架 / 小说 CRUD 接口（/novels）。
 */
import { BASE } from "@/constants/api";
import type { Novel } from "@/types/api";
import { httpError } from "./errors";

export async function listNovels(q?: string): Promise<Novel[]> {
  const url = q ? `${BASE}/novels?q=${encodeURIComponent(q)}` : `${BASE}/novels`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("加载小说失败");
  return res.json();
}

export async function getNovel(novelId: string): Promise<Novel> {
  const res = await fetch(`${BASE}/novels/${novelId}`);
  if (!res.ok) throw new Error("加载小说失败");
  return res.json();
}

export async function updateNovel(
  novelId: string,
  data: Partial<
    Pick<
      Novel,
      "title" | "premise" | "style_directive" | "style_directive_manual" | "background_type" | "genres" | "era_research"
    >
  >,
): Promise<Novel> {
  const res = await fetch(`${BASE}/novels/${novelId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "更新小说失败");
  }
  return res.json();
}

/** 删除小说及其全部关联数据（后端按依赖顺序显式清理各关联表）。 */
export async function deleteNovel(novelId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "删除小说失败");
  }
}

export async function createNovel(data: {
  title: string;
  premise?: string;
  background_type?: "realistic" | "alternate" | "pure_fantasy";
  genres?: string[];
}): Promise<Novel> {
  const res = await fetch(`${BASE}/novels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "创建失败");
  }
  return res.json();
}
