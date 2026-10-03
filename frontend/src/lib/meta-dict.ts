/**
 * @file lib/meta-dict.ts
 * 元数据字典统一缓存：按 key 从 /api/meta 拉取一次，命中缓存不再请求（跨组件共享，省开销）。
 * 枚举字典 key 与后端 app/api/meta.py 的 DICT_BUILDERS 对齐。
 */
import { getMetaDict } from "@/lib/api/meta";

/** 枚举字典 key（与后端 /api/meta 的字典 key 一一对应）。 */
export type MetaDictKey = "agents" | "task_types" | "genre_aliases";

/** 模块级缓存：key → 数据（拉取成功后写入；失败不写，下次可重试）。 */
const cache = new Map<MetaDictKey, unknown>();

/** 拉取指定字典（带缓存）；失败抛出，由调用方决定兜底。 */
export async function loadMetaDict<T>(key: MetaDictKey): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const data = await getMetaDict([key]);
  const value = data[key] as T;
  cache.set(key, value);
  return value;
}
