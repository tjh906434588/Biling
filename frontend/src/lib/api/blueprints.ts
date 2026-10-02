/**
 * @file lib/api/blueprints.ts
 * 蓝图接口（blueprint_architect 落库 + 激活归档 + 大纲导入/骨架校验，/novels/{id}/blueprints）。
 */
import { BASE } from "@/constants/api";
import type {
  ActivateBlueprintResult,
  Blueprint,
  BlueprintActivationStatusResult,
  BlueprintImportResult,
  OutlineSkeletonResult,
  OutlineTemplate,
} from "@/types/api";
import { httpError } from "./errors";

export async function listBlueprints(novelId: string, status?: string): Promise<Blueprint[]> {
  const url = status
    ? `${BASE}/novels/${novelId}/blueprints?status=${status}`
    : `${BASE}/novels/${novelId}/blueprints`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("加载蓝图失败");
  return res.json();
}

export async function getActiveBlueprint(novelId: string): Promise<Blueprint | null> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/active`);
  if (!res.ok) throw new Error("加载 active 蓝图失败");
  return res.json();
}

/** 「复制蓝图大纲」模板（后端单一事实来源，与识别机制同步；失败时前端回退本地缓存模板） */
export async function getOutlineTemplate(): Promise<OutlineTemplate> {
  const res = await fetch(`${BASE}/novels/blueprints/outline-template`);
  if (!res.ok) throw new Error("加载大纲模板失败");
  return res.json();
}

export async function activateBlueprint(novelId: string, blueprintId: string): Promise<ActivateBlueprintResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/${blueprintId}/activate`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "激活蓝图失败");
  }
  return res.json();
}

/** 查询该小说最近一次「蓝图激活」任务：刷新/切页后恢复「激活中…」按钮状态并轮询到完成。 */
export async function getBlueprintActivationStatus(novelId: string): Promise<BlueprintActivationStatusResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/activation`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询激活状态失败");
  }
  return res.json();
}

export async function deleteBlueprint(novelId: string, blueprintId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/${blueprintId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "删除蓝图失败");
  }
}

/** 导入外部生成的全书大纲（Word/PDF/Markdown）：后端提取文本，返回给前端预览编辑。 */
export async function importBlueprintFile(novelId: string, file: File): Promise<BlueprintImportResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/import`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "导入失败");
  }
  return res.json();
}

/** 导入大纲后的骨架语义校验：必填四件套（体量/分卷/人物/主线支线）+ 选填建议（爽点节奏/差异化卖点）。
 *  LLM 语义判断，失败回退关键词扫描；结果用于生成前的「建议补全」提示（可跳过）。
 *  signal 可选：用户清空内容/关闭弹窗时取消未完成的校验请求。 */
export async function checkOutlineSkeleton(
  novelId: string,
  text: string,
  signal?: AbortSignal,
): Promise<OutlineSkeletonResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/outline-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_doc: text }),
    signal,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = "";
    try {
      detail = (JSON.parse(raw) as { detail?: string })?.detail ?? "";
    } catch {
      detail = raw.slice(0, 200);
    }
    throw httpError(detail, "大纲骨架校验失败");
  }
  return res.json();
}
