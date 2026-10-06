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

/** 作者手动编辑正文后的就地自动保存：就地更新当前选中版本（不新建版本），返回更新后的版本。
 *  format_only=true 为「格式化排版」专用保存：允许对任意版本（含 AI 版本）原地写回格式化正文，
 *  不派生新版本、不触发确认式版本化。 */
export async function updateChapterVersion(
  novelId: string,
  chapterNo: number,
  versionId: string,
  data: { content?: string; title?: string; format_only?: boolean },
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

/** 创建人工章节草稿；chapter_no 省略时由后端追加到最大章号之后。 */
export async function createManualChapter(
  novelId: string,
  data: { chapter_no?: number; title?: string; content?: string; parent_version_id?: string },
): Promise<ChapterDetail> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "创建人工章节失败");
  }
  return res.json();
}

/** 仅人工用户动作修改章标题，并同步章级与目标版本标题。 */
export async function updateChapterTitle(
  novelId: string,
  chapterNo: number,
  data: { title: string; version_id?: string },
): Promise<ChapterDetail> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}/title`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存章节标题失败");
  }
  return res.json();
}

/** 从已有版本派生人工编辑版本，保留原版本并建立父子关系。 */
export async function deriveManualVersion(
  novelId: string,
  chapterNo: number,
  versionId: string,
  data: { source?: string; content?: string; title?: string },
): Promise<ChapterVersion> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}/versions/${versionId}/derive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "创建人工版本失败");
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
