/**
 * @file lib/api/outlines.ts
 * 章节大纲接口（大纲师产出，draft → approved，/novels/{id}/outlines）。
 */
import { BASE } from "@/constants/api";
import type { ApproveOutlineResult, Outline, OutlineApprovalStatusResult } from "@/types/api";
import { httpError } from "./errors";

export async function listOutlines(novelId: string, status?: string): Promise<Outline[]> {
  const url = status ? `${BASE}/novels/${novelId}/outlines?status=${status}` : `${BASE}/novels/${novelId}/outlines`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("加载大纲失败");
  return res.json();
}

/** 某一大纲所属章节的全部版本（历史版本切换用），按版本号升序。 */
export async function listOutlineVersions(novelId: string, outlineId: string): Promise<Outline[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/versions`);
  if (!res.ok) throw new Error("加载大纲版本失败");
  return res.json();
}

/** 该大纲所属章节是否已生成正文（批准新大纲时的二次确认依据）。 */
export async function outlineHasChapter(
  novelId: string,
  outlineId: string,
): Promise<{ chapter_no: number; has_chapter: boolean }> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/has-chapter`);
  if (!res.ok) throw new Error("查询章节状态失败");
  return res.json();
}

export async function approveOutline(novelId: string, outlineId: string): Promise<ApproveOutlineResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/approve`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "批准大纲失败");
  }
  return res.json();
}

/** 查询该小说最近一次「大纲批准」任务：刷新/切页后恢复「批准中…」按钮状态并轮询到完成。 */
export async function getOutlineApprovalStatus(novelId: string): Promise<OutlineApprovalStatusResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/approval`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询批准状态失败");
  }
  return res.json();
}
