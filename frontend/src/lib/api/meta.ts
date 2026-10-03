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
