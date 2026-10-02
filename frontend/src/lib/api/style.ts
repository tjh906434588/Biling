/**
 * @file lib/api/style.ts
 * 风格画像接口（学习 + 版本列表，/novels/{id}/style）。
 */
import { BASE } from "@/constants/api";
import type { StyleProfile } from "@/types/api";
import { httpError } from "./errors";

export async function listStyleProfiles(novelId: string): Promise<StyleProfile[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/style`);
  if (!res.ok) throw new Error("加载风格画像失败");
  return res.json();
}

export async function learnStyle(
  novelId: string,
  diffs: Array<{ id: string; original: string; edited: string }>,
): Promise<{ version: number; traits: StyleProfile["traits"]; avoid_list: string[]; source_diff_ids: string[] }> {
  const res = await fetch(`${BASE}/novels/${novelId}/style/learn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diffs }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "风格学习失败");
  }
  return res.json();
}
