/**
 * @file lib/api/novels.ts
 * 书架 / 小说 CRUD 接口（/novels）。
 */
import { BASE } from "@/constants/api";
import type { ChapterInfoControl, InfoControl, Novel } from "@/types/api";
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

/** 导出整本书为 zip：返回 blob + 建议文件名，由调用方触发浏览器下载。 */
export async function exportNovel(novelId: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${BASE}/novels/${novelId}/export`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "导出失败");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const filename = m ? decodeURIComponent(m[1]) : `biling-${novelId}.zip`;
  return { blob, filename };
}

/** 导入整本书 zip：后端还原为一本内容完全相同的新书，返回新书（可直接跳转续写）。 */
export async function importNovel(file: File): Promise<Novel> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${BASE}/novels/import`, { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "导入失败");
  }
  return res.json();
}

/** 读取某章信息控制（谁知道了什么）：chapter=该章自己填的，effective=当前生效合并（已定稿章节链 + 本章）。 */
export async function getChapterInfoControl(novelId: string, chapterNo: number): Promise<ChapterInfoControl> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}/info-control`);
  if (!res.ok) throw new Error("加载信息控制失败");
  return res.json();
}

/** 保存某章信息控制（生成/重写本章时填写；全空 = 清空该章）。 */
export async function saveChapterInfoControl(novelId: string, chapterNo: number, data: InfoControl): Promise<ChapterInfoControl> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}/info-control`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存信息控制失败");
  }
  return res.json();
}
