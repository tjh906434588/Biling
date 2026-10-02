/**
 * @file lib/api/chapters.ts
 * 章节与正文版本接口（/novels/{id}/chapters）：生成=草稿 → 手动定稿，版本详情可预览/激活。
 */
import { BASE } from "@/constants/api";
import type { ChapterDetail, ChapterListItem, ChapterVersion } from "@/types/api";
import { httpError } from "./errors";

export async function listChapters(novelId: string): Promise<ChapterListItem[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters`);
  if (!res.ok) throw new Error("加载章节失败");
  return res.json();
}

export async function getChapter(novelId: string, chapterNo: number): Promise<ChapterDetail> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}`);
  if (!res.ok) throw new Error("加载章节详情失败");
  return res.json();
}

/** 作者手动编辑正文后的就地自动保存：就地更新当前选中版本（不新建版本），返回更新后的版本。 */
export async function updateChapterVersion(
  novelId: string,
  chapterNo: number,
  versionId: string,
  data: { content?: string; title?: string },
): Promise<ChapterVersion> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}/versions/${versionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存正文失败");
  }
  return res.json();
}

export async function selectVersion(
  novelId: string,
  chapterNo: number,
  versionId: string,
  force = false,
): Promise<ChapterDetail> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version_id: versionId, force }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "选定版本失败");
  }
  return res.json();
}
