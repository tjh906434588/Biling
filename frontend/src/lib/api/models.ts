/**
 * @file lib/api/models.ts
 * 模型接入与路由接口（/models）：预置目录、路由管理、Key、默认模型、自定义/接入模型、探测与刷新。
 */
import { BASE } from "@/constants/api";
import type {
  CatalogProvider,
  CustomModelSaveInput,
  CustomModelSaved,
  DefaultModel,
  ModelRoute,
  ProviderKeyStatus,
} from "@/types/api";
import { httpError } from "./errors";

// ---------- 模型路由管理 ----------

export async function listRoutes(): Promise<ModelRoute[]> {
  const res = await fetch(`${BASE}/models/routes`);
  if (!res.ok) throw new Error("加载模型路由失败");
  return res.json();
}

export async function upsertRoute(
  data: { task_type: ModelRoute["task_type"]; provider: string; model: string; temperature?: number | null; max_tokens?: number | null; context_window?: number | null; is_default?: boolean },
): Promise<ModelRoute> {
  const res = await fetch(`${BASE}/models/routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存路由失败");
  }
  return res.json();
}

export async function updateRoute(
  routeId: string,
  data: { task_type: ModelRoute["task_type"]; provider: string; model: string; temperature?: number | null; max_tokens?: number | null; context_window?: number | null; is_default?: boolean },
): Promise<ModelRoute> {
  const res = await fetch(`${BASE}/models/routes/${routeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "更新路由失败");
  }
  return res.json();
}

export async function deleteRoute(routeId: string): Promise<void> {
  const res = await fetch(`${BASE}/models/routes/${routeId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除路由失败");
}

// ---------- 模型接入（API Key + 默认模型，页面配置，实时生效） ----------

/** 预置模型目录：服务商 + 官方地址 + 推荐模型 + Key 状态（对齐后端 MODEL_CATALOG + 自定义模型）。 */
export async function listModelCatalog(): Promise<CatalogProvider[]> {
  const res = await fetch(`${BASE}/models/catalog`);
  if (!res.ok) throw new Error("加载模型目录失败");
  return res.json();
}

/** 「添加模型」弹窗自定义配置：新增一个自定义模型（自动写 Key + 清单）。 */
export async function saveCustomModel(input: CustomModelSaveInput): Promise<CustomModelSaved> {
  const res = await fetch(`${BASE}/models/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存自定义模型失败");
  }
  return res.json();
}

export async function deleteCustomModel(provider: string): Promise<void> {
  const res = await fetch(`${BASE}/models/custom/${encodeURIComponent(provider)}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除自定义模型失败");
}

export async function getDefaultModel(): Promise<DefaultModel | null> {
  const res = await fetch(`${BASE}/models/default`);
  if (!res.ok) throw new Error("加载默认模型失败");
  return res.json();
}

export async function setDefaultModel(provider: string, model: string): Promise<void> {
  const res = await fetch(`${BASE}/models/default`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存默认模型失败");
  }
}

export async function listProviderKeys(): Promise<Record<string, ProviderKeyStatus>> {
  const res = await fetch(`${BASE}/models/keys`);
  if (!res.ok) throw new Error("加载模型接入失败");
  return res.json();
}

export async function saveProviderKey(provider: string, apiKey: string, baseUrl?: string): Promise<void> {
  const res = await fetch(`${BASE}/models/keys/${encodeURIComponent(provider)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, base_url: baseUrl || null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存失败");
  }
}

export async function deleteProviderKey(provider: string): Promise<void> {
  const res = await fetch(`${BASE}/models/keys/${encodeURIComponent(provider)}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除失败");
}

/** 把一个模型接入并独立保存其 Key（同服务商不同模型互不影响；重复添加同一模型则更新该条）。 */
export async function addAccessModel(
  provider: string,
  model: string,
  apiKey: string,
  baseUrl?: string,
  label?: string,
): Promise<void> {
  const res = await fetch(`${BASE}/models/access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, label: label || null, base_url: baseUrl || null, api_key: apiKey }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "接入模型失败");
  }
}

/** 从已接入清单移除一个模型；若移除的是默认模型则自动改用其他可用模型。 */
export async function removeAccessModel(provider: string, model: string): Promise<void> {
  const res = await fetch(
    `${BASE}/models/access?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error("移除模型失败");
}

/** 用输入框里的 Key 探测账号可用模型（不落库），验证连通 + 帮助填路由。 */
export async function probeProvider(
  provider: string,
  apiKey: string,
  baseUrl?: string,
  model?: string,
): Promise<string[]> {
  const res = await fetch(`${BASE}/models/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, api_key: apiKey, base_url: baseUrl || null, model: model || null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "测试连接失败");
  }
  const data = await res.json();
  return data.models ?? [];
}

/** 「刷新模型列表」：用 Key 从服务商拉取账号下的真实模型并缓存，替代静态种子目录。 */
export async function refreshCatalogModels(
  provider: string,
  apiKey: string,
  baseUrl?: string,
  model?: string,
): Promise<{ provider: string; models: { id: string; label: string }[]; updated_at: string; source: string }> {
  const res = await fetch(`${BASE}/models/catalog/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, api_key: apiKey, base_url: baseUrl || null, model: model || null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "刷新模型列表失败");
  }
  return res.json();
}
