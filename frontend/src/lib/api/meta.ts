/**
 * @file lib/api/meta.ts
 * 元数据字典接口（/api/meta）：角色名 / 任务类型 / 题材别名等枚举数据按 key 聚合下发，
 * 前端统一经此拉取并缓存（见 @/lib/meta-dict），不再各自一个接口。
 */
import { BASE } from "@/constants/api";

/** 拉取元数据字典：keys 省略 = 全部；返回 { key: 数据 }。 */
export async function getMetaDict(keys?: string[]): Promise<Record<string, unknown>> {
  const q = keys && keys.length ? `?keys=${keys.join(",")}` : "";
  const res = await fetch(`${BASE}/meta${q}`);
  if (!res.ok) throw new Error("加载元数据失败");
  return res.json();
}

/** 给指定字典新增一个用户自定义项（如自定义题材）；成功返回 {value,label}。 */
export async function addMetaDictItem(
  key: string,
  value: string,
  label?: string,
): Promise<{ value: string; label: string }> {
  const res = await fetch(`${BASE}/meta/${key}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, label }),
  });
  if (!res.ok) {
    let msg = "添加自定义项失败";
    try {
      const data = await res.json();
      if (data && typeof data.detail === "string") msg = data.detail;
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(msg);
  }
  return res.json();
}

/** 删除指定字典的一个用户自定义项；成功返回 {ok:true}。 */
export async function deleteMetaDictItem(key: string, value: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/meta/${key}/items/${encodeURIComponent(value)}`, { method: "DELETE" });
  if (!res.ok) {
    let msg = "删除自定义项失败";
    try {
      const data = await res.json();
      if (data && typeof data.detail === "string") msg = data.detail;
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(msg);
  }
  return res.json();
}
