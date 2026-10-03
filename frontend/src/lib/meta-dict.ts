/**
 * @file lib/meta-dict.ts
 * 元数据字典统一缓存：按 key 从 /api/meta 拉取，模块级缓存 + TTL 过期（懒过期：
 * 访问时判断是否过期，过期才重新拉取；不做后台定时刷新，避免无谓请求）。
 * 枚举字典 key 与后端 app/api/meta.py 的 DICT_BUILDERS 对齐。
 */
import { getMetaDict } from "@/lib/api/meta";

/** 枚举字典 key（与后端 /api/meta 的字典 key 一一对应）。 */
export type MetaDictKey =
  | "agents"
  | "task_types"
  | "genre_aliases"
  | "chapter_functions"
  | "setting_types"
  | "role_ranks"
  | "stages";

/** 字典缓存 TTL（ms）：枚举数据变化低频，10 分钟足够保证"最新"，过期后自动重拉。 */
export const META_DICT_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** 模块级缓存：key → 缓存条目（拉取成功后写入；失败不写，下次可重试）。 */
const cache = new Map<MetaDictKey, CacheEntry<unknown>>();

/** 拉取指定字典（带 TTL 缓存：命中且未过期直接用；过期/缺失重新拉取）；失败抛出，由调用方兜底。 */
export async function loadMetaDict<T>(key: MetaDictKey): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value as T;
  const data = await getMetaDict([key]);
  const value = data[key] as T;
  cache.set(key, { value, expiresAt: Date.now() + META_DICT_TTL_MS });
  return value;
}
