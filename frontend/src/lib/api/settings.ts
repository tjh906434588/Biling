/**
 * @file lib/api/settings.ts
 * 设定库接口（/novels/{id}/settings）。
 */
import { BASE } from "@/constants/api";
import type { Setting, SettingSource, SettingType } from "@/types/api";
import { httpError } from "./errors";

export async function listSettings(novelId: string, type?: string, q?: string): Promise<Setting[]> {
  const p = new URLSearchParams();
  if (type) p.set("type", type);
  if (q) p.set("q", q);
  const qs = p.toString();
  const res = await fetch(`${BASE}/novels/${novelId}/settings${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("加载设定失败");
  return res.json();
}

export async function createSetting(
  novelId: string,
  data: {
    type: SettingType;
    name: string;
    source?: SettingSource;
    description?: string;
    is_constitution?: boolean;
    structured?: Record<string, unknown>;
  },
): Promise<Setting> {
  const res = await fetch(`${BASE}/novels/${novelId}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "创建设定失败");
  }
  return res.json();
}

export async function updateSetting(
  novelId: string,
  settingId: string,
  data: Partial<Pick<Setting, "name" | "description" | "is_constitution" | "structured">>,
): Promise<Setting> {
  const res = await fetch(`${BASE}/novels/${novelId}/settings/${settingId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "更新设定失败");
  }
  return res.json();
}

export async function deleteSetting(novelId: string, settingId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}/settings/${settingId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除设定失败");
}
