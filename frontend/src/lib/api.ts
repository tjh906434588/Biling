/**
 * @file lib/api.ts
 * 笔灵前端 API 客户端：直接走 Next.js rewrite 代理（/api/* → 后端 8000）。
 * 领域/API 类型已集中到 @/types/api（此处 `export *` 向后兼容，业务代码仍可从 "@/lib/api" 导入），
 * 请求前缀 BASE 等共享常量统一维护在 @/constants。
 */
import { BASE } from "@/constants/api";
import type {
  ActivateBlueprintResult,
  AgentPrompt,
  AgentRunningTaskResult,
  ApproveOutlineResult,
  AuthorConfirm,
  Blueprint,
  BlueprintActivationStatusResult,
  BlueprintImportResult,
  CatalogProvider,
  ChapterDetail,
  ChapterListItem,
  ChapterVersion,
  CustomModelSaveInput,
  CustomModelSaved,
  DefaultModel,
  DetectResult,
  GraphView,
  LedgerItem,
  MemoryReview,
  ModelRoute,
  Novel,
  Outline,
  OutlineApprovalStatusResult,
  OutlineSkeletonResult,
  OutlineTemplate,
  ProviderKeyStatus,
  QualityReview,
  Setting,
  SettingSource,
  SettingType,
  StreamEvent,
  StreamEventData,
  StreamStatusResult,
  StyleProfile,
  WritingPromptField,
} from "@/types/api";
export * from "@/types/api";

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

// ---------- 设定库（settings CRUD，M1） ----------

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

// ---------- 章节（生成=草稿 → 手动定稿，版本详情可预览/激活） ----------

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

// ---------- 质量账本（评价师产出，quality_reviews） ----------

/** 某小说的评价列表（可按章过滤），最新在前。 */
export async function listReviews(novelId: string, chapterNo?: number): Promise<QualityReview[]> {
  const qs = chapterNo != null ? `?chapter_no=${chapterNo}` : "";
  const res = await fetch(`${BASE}/novels/${novelId}/reviews${qs}`);
  if (!res.ok) throw new Error("加载评价失败");
  return res.json();
}

// ---------- 章节大纲（M2：大纲师产出，draft → approved） ----------

export async function listOutlines(novelId: string, status?: string): Promise<Outline[]> {
  const url = status ? `${BASE}/novels/${novelId}/outlines?status=${status}` : `${BASE}/novels/${novelId}/outlines`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("加载大纲失败");
  return res.json();
}

/** 某一大纲所属章节的全部版本（历史版本切换用），按版本号升序。 */
export async function listOutlineVersions(novelId: string, outlineId: string): Promise<Outline[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/versions`);
  if (!res.ok) throw new Error("加载大纲版本失败");
  return res.json();
}

/** 该大纲所属章节是否已生成正文（批准新大纲时的二次确认依据）。 */
export async function outlineHasChapter(
  novelId: string,
  outlineId: string,
): Promise<{ chapter_no: number; has_chapter: boolean }> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/has-chapter`);
  if (!res.ok) throw new Error("查询章节状态失败");
  return res.json();
}

export async function approveOutline(novelId: string, outlineId: string): Promise<ApproveOutlineResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/approve`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "批准大纲失败");
  }
  return res.json();
}

/** 查询该小说最近一次「大纲批准」任务：刷新/切页后恢复「批准中…」按钮状态并轮询到完成。 */
export async function getOutlineApprovalStatus(novelId: string): Promise<OutlineApprovalStatusResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/approval`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询批准状态失败");
  }
  return res.json();
}

// ---------- 伏笔账本（M2：大纲师登记 + 手动维护 + 超期视图） ----------

export async function listLedger(
  novelId: string,
  opts?: { status?: string; item_type?: string; overdue_only?: boolean },
): Promise<LedgerItem[]> {
  const p = new URLSearchParams();
  if (opts?.status) p.set("status", opts.status);
  if (opts?.item_type) p.set("item_type", opts.item_type);
  if (opts?.overdue_only) p.set("overdue_only", "true");
  const qs = p.toString();
  const res = await fetch(`${BASE}/novels/${novelId}/ledger${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("加载伏笔账本失败");
  return res.json();
}

export async function listOverdueLedger(novelId: string): Promise<LedgerItem[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/overdue`);
  if (!res.ok) throw new Error("加载超期伏笔失败");
  return res.json();
}

export async function updateLedger(
  novelId: string,
  itemId: string,
  data: Partial<Pick<LedgerItem, "description" | "urgency" | "target_reveal_chapter" | "status">>,
): Promise<LedgerItem> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "更新伏笔失败");
  }
  return res.json();
}

export async function deleteLedger(novelId: string, itemId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/${itemId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除伏笔失败");
}

// ---------- 蓝图（M3：blueprint_architect 落库 + 激活归档） ----------

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

// ---------- AI 生成任务持久化（页面刷新后恢复"生成中"状态） ----------

/** 查询该小说该角色是否有进行中的生成任务（刷新后恢复生成中状态用）。 */
export async function getAgentRunningTask(
  agent: string,
  novelId: string,
): Promise<AgentRunningTaskResult> {
  const res = await fetch(`${BASE}/stream/agents/${agent}/tasks?novel_id=${novelId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询生成任务失败");
  }
  return res.json();
}

/** 查询该小说最近的 AI 生成任务（含进行中/刚完成）：刷新或切页回来后恢复状态用。 */
export async function getStreamStatus(novelId: string): Promise<StreamStatusResult> {
  const res = await fetch(`${BASE}/stream/agents/status?novel_id=${novelId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "查询生成任务失败");
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

// ---------- 风格画像（M3：学习 + 版本列表） ----------

export async function listStyleProfiles(novelId: string): Promise<StyleProfile[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/style`);
  if (!res.ok) throw new Error("加载风格画像失败");
  return res.json();
}

export async function learnStyle(
  novelId: string,
  diffs: Array<{ id: string; original: string; edited: string }>,
): Promise<{ version: number; traits: StyleProfile["traits"]; avoid_list: string[]; source_diff_ids: string[] }> {
  const res = await fetch(`${BASE}/novels/${novelId}/style/learn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diffs }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "风格学习失败");
  }
  return res.json();
}

// ---------- AI 检测（M4：体检，不阻断） ----------

export async function detectText(novelId: string, text: string): Promise<DetectResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "检测失败");
  }
  return res.json();
}

// ---------- 实体图谱 + 记忆审查（M4） ----------

export async function getGraph(novelId: string): Promise<GraphView> {
  const res = await fetch(`${BASE}/novels/${novelId}/graph`);
  if (!res.ok) throw new Error("加载图谱失败");
  return res.json();
}

export async function getMemoryReview(novelId: string): Promise<MemoryReview> {
  const res = await fetch(`${BASE}/novels/${novelId}/memory-review`);
  if (!res.ok) throw new Error("加载记忆审查失败");
  return res.json();
}

// ---------- 模型路由管理（M4） ----------

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

/**
 * 查询待作者确认的请求。
 * - 传 novelId：只查该小说（刷新后恢复当前工作台弹窗）；
 * - 不传：返回所有小说的待确认项（全局确认提醒中心跨小说轮询，用于"不在对应工作台也要提醒"）。
 * agent 传入时精确到角色。
 */
export async function fetchPendingConfirms(novelId?: string, agent?: string): Promise<AuthorConfirm[]> {
  const q = new URLSearchParams();
  if (novelId) q.set("novel_id", novelId);
  if (agent) q.set("agent", agent);
  const res = await fetch(`${BASE}/stream/agents/confirm?${q}`);
  if (!res.ok) throw new Error("查询作者确认请求失败");
  const data = await res.json();
  return (data.items ?? []) as AuthorConfirm[];
}

/**
 * 提交作者确认：answer 为选项 id / 自定义文本 / __regenerate__ / __fields__；
 * note 为可选补充说明；fieldAnswers 为场景卡片确认的字段答案（字段 → 选定文本）。
 */
export async function submitAuthorConfirm(
  confirmId: string,
  answer: string,
  note?: string,
  fieldAnswers?: Record<string, string>,
): Promise<AuthorConfirm> {
  const res = await fetch(`${BASE}/stream/agents/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm_id: confirmId,
      answer,
      note: note || undefined,
      field_answers: fieldAnswers && Object.keys(fieldAnswers).length > 0 ? fieldAnswers : undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "提交作者确认失败");
  }
  return res.json() as Promise<AuthorConfirm>;
}

/** 作者主动跳过确认点（关闭弹窗）：后端 dismissed，生成任务按默认方向继续。 */
export async function dismissAuthorConfirm(confirmId: string): Promise<void> {
  const res = await fetch(`${BASE}/stream/agents/confirm/${confirmId}/dismiss`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "跳过作者确认失败");
  }
}

/** 调用角色 SSE 接口，逐事件回调（使用 fetch ReadableStream 手动解析 SSE）。 */
export async function runAgent(
  agent: string,
  novelId: string,
  params: Record<string, unknown>,
  onEvent: (ev: StreamEventData) => void,
  signal?: AbortSignal,
  dryRun = false,
  timeoutMs?: number,
): Promise<void> {
  // 超时兜底：代理/网络层偶发挂起时（曾见 SSE 长连接 500s+ 无响应），超过 timeoutMs 中断连接并抛错，
  // 避免 UI 永久"思考中"。注意：这里只断开前端读取，后端任务脱离请求生命周期会照常跑完并落库（刷新可见）。
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer =
    timeoutMs != null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  try {
    const res = await fetch(`${BASE}/stream/agents/${agent}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ novel_id: novelId, params, dry_run: dryRun }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error("请求失败");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const dispatch = () => {
      // SSE 事件以空行分隔
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event: StreamEvent = "stream_delta";
        let data = "";
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim() as StreamEvent;
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        onEvent({ event, data: parsed });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      dispatch();
    }
    buffer += decoder.decode();
    dispatch();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

/** 把运行期异常转成对用户友好的提示：网络层中断（长等待时连接被代理/网关掐断）给出可操作建议。 */
export function friendlyRunError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return "等待 AI 响应超时，已自动中断显示。生成任务可能仍在后台继续，请稍后刷新页面查看结果；若反复超时，可重试。";
  }
  if (/terminated|load failed|network error|fetch failed|aborted|chunked|ECONNRESET|socket|timed out/i.test(raw)) {
    return "网络连接中断，生成未完成。输入内容已保留，请直接重试；若反复失败，可把导入文档精简后重试。";
  }
  return raw;
}

/** 把 AI 任务/接口返回的错误转成用户可读文案：
 *  后端错误本身是中文 → 原样展示；空值/纯英文/状态码等技术信息 → 统一用中文兜底，避免用户看到裸英文或 HTTP 码。 */
export function friendlyTaskError(err?: string | null, fallback = "AI 任务执行出错，请稍后重试。"): string {
  if (!err || !String(err).trim()) return fallback;
  const s = String(err).trim();
  return /[\u4e00-\u9fff]/.test(s) ? s : fallback;
}

/** 把 fetch 的错误响应 detail 包装成友好错误（英文 detail / 空 detail → 中文兜底，隐藏裸 HTTP 状态码）。 */
export function httpError(detail: unknown, fallback: string): Error {
  return new Error(friendlyTaskError(detail ? String(detail) : "", fallback));
}

/** 把调试 dry_run 的产物显式加入正式库（不重新调用 AI）。 */
export async function commitAgent(
  agent: string,
  novelId: string,
  params: Record<string, unknown>,
  output: Record<string, unknown>,
  source?: string,
): Promise<{ action?: string; detail?: string }> {
  const res = await fetch(`${BASE}/stream/agents/${agent}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novel_id: novelId, params, output, source }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "提交失败");
  }
  return res.json();
}

// ---------- 每部小说独立的写作指令（各创作/评审角色的可配置 System Prompt 片段） ----------

export async function listPrompts(novelId: string): Promise<AgentPrompt[]> {
  const res = await fetch(`${BASE}/prompts?novel_id=${novelId}`);
  if (!res.ok) throw new Error("加载写作指令失败");
  return res.json();
}

export async function updatePrompt(
  novelId: string,
  agentKey: string,
  fields: Partial<Record<WritingPromptField, string>>,
): Promise<AgentPrompt> {
  const res = await fetch(`${BASE}/prompts/${agentKey}?novel_id=${novelId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mindset: fields.mindset ?? "",
      style_rules: fields.style_rules ?? "",
      forbidden: fields.forbidden ?? "",
      check_standard: fields.check_standard ?? "",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "保存写作指令失败");
  }
  return res.json();
}

/** 删除某角色的自定义配置（恢复内置默认）。 */
export async function resetPrompt(novelId: string, agentKey: string): Promise<AgentPrompt> {
  const res = await fetch(`${BASE}/prompts/${agentKey}?novel_id=${novelId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "恢复默认失败");
  }
  return res.json();
}
