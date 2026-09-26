// 笔灵前端 API 客户端：直接走 Next.js rewrite 代理（/api/* → 后端 8000）
const BASE = "/api";

export interface Novel {
  id: string;
  title: string;
  /** 一句话简介（后端字段名是 premise，早期版本误用 description 导致简介永远存不上） */
  premise?: string | null;
  /** 蓝图识别文风：导入蓝图时自动覆盖（前端只读） */
  style_directive?: string | null;
  /** 手动添加文风：作者手动维护，导入蓝图不会覆盖 */
  style_directive_manual?: string | null;
  /** 世界背景类型：realistic=现实年代 | alternate=半架空 | pure_fantasy=纯架空（签约核查口径按类型切换）。
   *  可空：未选择（不确定可不选，导入蓝图时 AI 按素材推断、作者确认后落库） */
  background_type?: "realistic" | "alternate" | "pure_fantasy" | null;
  /** 题材多选（软性写作方向指引）：如 ["都市","重生"]，复合题材可多选 */
  genres?: string[];
  /** 时代行业研究（运行时按需生成，作者可改）：机构形态/老板画像/业务/演进/时代雷点 */
  era_research?: Record<string, unknown> | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

export async function listNovels(q?: string): Promise<Novel[]> {
  const url = q ? `${BASE}/novels?q=${encodeURIComponent(q)}` : `${BASE}/novels`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载小说失败：${res.status}`);
  return res.json();
}

export async function getNovel(novelId: string): Promise<Novel> {
  const res = await fetch(`${BASE}/novels/${novelId}`);
  if (!res.ok) throw new Error(`加载小说失败：${res.status}`);
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
    throw new Error(err.detail || `更新小说失败：${res.status}`);
  }
  return res.json();
}

/** 删除小说及其全部关联数据（后端按依赖顺序显式清理各关联表）。 */
export async function deleteNovel(novelId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除小说失败：${res.status}`);
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
    throw new Error(err.detail || `创建失败：${res.status}`);
  }
  return res.json();
}

// ---------- 设定库（settings CRUD，M1） ----------

export const SETTING_TYPES = [
  "character",
  "location",
  "faction",
  "world_rule",
  "item",
  "concept",
] as const;

export type SettingType = (typeof SETTING_TYPES)[number];

/** 设定数据来源：blueprint 蓝图导入（按版本存储，仅当前生效蓝图的导入设定可见）| outline 大纲批准时注入（按来源版本切换显示/隐藏）| batch 批量新增 | manual 单个新增 | extraction 正文提取（首次登场即建档） */
export type SettingSource = "blueprint" | "batch" | "manual" | "outline" | "extraction";

export interface Setting {
  id: string;
  novel_id: string;
  type: SettingType;
  name: string;
  source: SettingSource;
  /** 所属蓝图版本（source="blueprint" 时记录导入它的蓝图；手动/批量设定为 null） */
  blueprint_id: string | null;
  description: string | null;
  structured: Record<string, unknown> | null;
  is_constitution: boolean;
  created_at: string;
}

export async function listSettings(novelId: string, type?: string, q?: string): Promise<Setting[]> {
  const p = new URLSearchParams();
  if (type) p.set("type", type);
  if (q) p.set("q", q);
  const qs = p.toString();
  const res = await fetch(`${BASE}/novels/${novelId}/settings${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`加载设定失败：${res.status}`);
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
    throw new Error(err.detail || `创建设定失败：${res.status}`);
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
    throw new Error(err.detail || `更新设定失败：${res.status}`);
  }
  return res.json();
}

export async function deleteSetting(novelId: string, settingId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}/settings/${settingId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`删除设定失败：${res.status}`);
}

// ---------- 章节（生成=草稿 → 手动定稿，版本详情可预览/激活） ----------

export interface ChapterVersion {
  id: string;
  version_no: number;
  source: string;
  /** 该版本自己的标题（草稿各自独立，定稿时同步回章节）。 */
  title: string | null;
  content: string;
  note: string | null;
  outline_id: string | null;
  /** 版本树父节点 id：null=根（新增章节/重新生成正文）；非 null=评价优化产物（多级树）。 */
  parent_version_id: string | null;
  is_active: boolean; // true=已定稿（当前激活版本）
  /** 签约未过签：最新评价存在 severity=high 的红线 issue → true，定稿默认被拒；null=尚无评价。 */
  signing_blocked: boolean | null;
  created_at: string;
}

export interface ChapterListItem {
  id: string;
  chapter_no: number;
  title: string | null;
  status: string;
  word_count: number | null;
  updated_at: string;
  active_source: string | null;
  active_content: string | null;
  extracted_version_id: string | null; // 该章提取入记忆层时对应的正文版本（未提取过为 null）
}

export interface ChapterDetail {
  chapter_no: number;
  title: string | null;
  status: string;
  versions: ChapterVersion[];
}

export async function listChapters(novelId: string): Promise<ChapterListItem[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters`);
  if (!res.ok) throw new Error(`加载章节失败：${res.status}`);
  return res.json();
}

export async function getChapter(novelId: string, chapterNo: number): Promise<ChapterDetail> {
  const res = await fetch(`${BASE}/novels/${novelId}/chapters/${chapterNo}`);
  if (!res.ok) throw new Error(`加载章节详情失败：${res.status}`);
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
    throw new Error(err.detail || `选定版本失败：${res.status}`);
  }
  return res.json();
}

// ---------- 质量账本（评价师产出，quality_reviews） ----------

export interface QualityReview {
  id: string;
  chapter_no: number | null;
  chapter_title: string | null;
  /** 评价所针对的正文版本；null 表示非章节评价（如 schema 告警）。 */
  chapter_version_id: string | null;
  version_no: number | null;
  version_source: string | null;
  /** 该版本是否为本章当前激活版本；false → 评价已随版本更替而过期。 */
  is_current: boolean;
  overall_score: number | null;
  rubric: Record<string, { score?: number; comment?: string; evidence?: string }> | null;
  issues: Array<{ severity?: string; type?: string; desc?: string; suggested_fix?: string }> | null;
  strengths: string[] | null;
  revision_hints: string[] | null;
  created_at: string;
}

/** 某小说的评价列表（可按章过滤），最新在前。 */
export async function listReviews(novelId: string, chapterNo?: number): Promise<QualityReview[]> {
  const qs = chapterNo != null ? `?chapter_no=${chapterNo}` : "";
  const res = await fetch(`${BASE}/novels/${novelId}/reviews${qs}`);
  if (!res.ok) throw new Error(`加载评价失败：${res.status}`);
  return res.json();
}

// ---------- 章节大纲（M2：大纲师产出，draft → approved） ----------

export interface Outline {
  id: string;
  novel_id: string;
  chapter_no: number;
  version_no: number;
  title: string | null;
  content: Record<string, unknown>;
  status: "draft" | "approved";
  created_at: string;
  /** 仅批准响应携带：本次批准时注入设定库的新角色名 */
  injected_characters?: string[];
}

export async function listOutlines(novelId: string, status?: string): Promise<Outline[]> {
  const url = status ? `${BASE}/novels/${novelId}/outlines?status=${status}` : `${BASE}/novels/${novelId}/outlines`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载大纲失败：${res.status}`);
  return res.json();
}

/** 某一大纲所属章节的全部版本（历史版本切换用），按版本号升序。 */
export async function listOutlineVersions(novelId: string, outlineId: string): Promise<Outline[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/versions`);
  if (!res.ok) throw new Error(`加载大纲版本失败：${res.status}`);
  return res.json();
}

/** 该大纲所属章节是否已生成正文（批准新大纲时的二次确认依据）。 */
export async function outlineHasChapter(
  novelId: string,
  outlineId: string,
): Promise<{ chapter_no: number; has_chapter: boolean }> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/has-chapter`);
  if (!res.ok) throw new Error(`查询章节状态失败：${res.status}`);
  return res.json();
}

export interface ApproveOutlineResult {
  /** true=已在后台启动批准注入（前端轮询批准状态直到成功/失败）；false=已生效/无需批准 */
  running: boolean;
  task_id: string | null;
  outline_id: string;
  chapter_no: number;
  version_no: number;
}

export async function approveOutline(novelId: string, outlineId: string): Promise<ApproveOutlineResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/${outlineId}/approve`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `批准大纲失败：${res.status}`);
  }
  return res.json();
}

export interface OutlineApprovalTask {
  id: string;
  outline_id: string | null;
  chapter_no: number | null;
  version_no: number | null;
  status: "running" | "done" | "error";
  msg: string | null;
  error: string | null;
  /** 本次批准注入设定库的新角色名（任务完成后携带） */
  injected_characters: string[];
  started_at: string | null;
  updated_at: string | null;
}

export interface OutlineApprovalStatusResult {
  running: boolean;
  task: OutlineApprovalTask | null;
}

/** 查询该小说最近一次「大纲批准」任务：刷新/切页后恢复「批准中…」按钮状态并轮询到完成。 */
export async function getOutlineApprovalStatus(novelId: string): Promise<OutlineApprovalStatusResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/outlines/approval`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `查询批准状态失败：${res.status}`);
  }
  return res.json();
}

// ---------- 伏笔账本（M2：大纲师登记 + 手动维护 + 超期视图） ----------

export type LedgerType = "setup" | "thread" | "character_state" | "location_state" | "unresolved_hook";

export type LedgerStatus = "open" | "closed" | "abandoned";

export const LEDGER_TYPE_LABELS: Record<LedgerType, string> = {
  setup: "埋设伏笔",
  thread: "线索推进",
  character_state: "角色状态",
  location_state: "地点状态",
  unresolved_hook: "未解钩子",
};

export interface LedgerItem {
  id: string;
  novel_id: string;
  item_type: LedgerType;
  description: string;
  related_entity: string | null;
  chapter_introduced: number | null;
  chapter_resolved: number | null;
  urgency: number | null;
  target_reveal_chapter: number | null;
  status: LedgerStatus;
  confidence: string;
  created_at: string;
  overdue: boolean;
  stale: boolean;
}

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
  if (!res.ok) throw new Error(`加载伏笔账本失败：${res.status}`);
  return res.json();
}

export async function listOverdueLedger(novelId: string): Promise<LedgerItem[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/overdue`);
  if (!res.ok) throw new Error(`加载超期伏笔失败：${res.status}`);
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
    throw new Error(err.detail || `更新伏笔失败：${res.status}`);
  }
  return res.json();
}

export async function deleteLedger(novelId: string, itemId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/${itemId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`删除伏笔失败：${res.status}`);
}

// ---------- 蓝图（M3：blueprint_architect 落库 + 激活归档） ----------

export interface Blueprint {
  id: string;
  novel_id: string;
  version: number;
  parent_id: string | null;
  content: {
    title?: string;
    logline?: string;
    theme?: string;
    core_conflict?: string;
    /** 全书体量规划（作者执行专用） */
    total_word_count?: string;
    total_chapters?: string;
    chapter_word_count?: string;
    world_rules?: Array<{ name?: string; detail?: string; constraints?: string[] }>;
    character_arcs?: Array<{ character?: string; personality?: string; start?: string; end?: string; turning_points?: string[] }>;
    volumes?: Array<{ no?: number; name?: string; focus?: string; chapters_range?: string; word_count?: string; chapter_count?: string }>;
    foreshadowing_plan?: Array<{ plant_chapter?: number; payoff_chapter?: number; desc?: string }>;
    subplots?: string[];
    /** 通用保留区：无法归入既有字段的重要信息（风格/参考/特殊约束等），原样保留 */
    notes?: string[];
    /** 导入模式：导入文档与设定库的不一致记录（正常生成恒为空） */
    blueprint_conflicts?: Array<{
      item?: string;
      doc_content?: string;
      settings_content?: string;
      resolution?: string;
    }>;
  };
  status: "active" | "inactive";
  /** 该版本来自的导入文档名（非导入生成则为 null），用于标注可做校验比对 */
  doc_name?: string | null;
  /** 激活时设定/文风抽取未成功的提示（仅激活接口可能返回，其余接口恒为空） */
  extract_warning?: string | null;
  created_at: string;
}

export async function listBlueprints(novelId: string, status?: string): Promise<Blueprint[]> {
  const url = status
    ? `${BASE}/novels/${novelId}/blueprints?status=${status}`
    : `${BASE}/novels/${novelId}/blueprints`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载蓝图失败：${res.status}`);
  return res.json();
}

export async function getActiveBlueprint(novelId: string): Promise<Blueprint | null> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/active`);
  if (!res.ok) throw new Error(`加载 active 蓝图失败：${res.status}`);
  return res.json();
}

export interface ActivateBlueprintResult {
  /** true=已在后台启动激活（前端轮询激活状态直到成功/失败）；false=已生效/无需激活 */
  running: boolean;
  task_id: string | null;
  blueprint_id: string;
  version: number;
}

export async function activateBlueprint(novelId: string, blueprintId: string): Promise<ActivateBlueprintResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/${blueprintId}/activate`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `激活蓝图失败：${res.status}`);
  }
  return res.json();
}

export interface BlueprintActivationTask {
  id: string;
  blueprint_id: string | null;
  version: number | null;
  status: "running" | "done" | "error";
  msg: string | null;
  error: string | null;
  /** 激活成功但设定/文风抽取未成功的提示（可手动补充或重新激活重试） */
  warning: string | null;
  started_at: string | null;
  updated_at: string | null;
}

export interface BlueprintActivationStatusResult {
  running: boolean;
  task: BlueprintActivationTask | null;
}

/** 查询该小说最近一次「蓝图激活」任务：刷新/切页后恢复「激活中…」按钮状态并轮询到完成。 */
export async function getBlueprintActivationStatus(novelId: string): Promise<BlueprintActivationStatusResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/activation`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `查询激活状态失败：${res.status}`);
  }
  return res.json();
}

export async function deleteBlueprint(novelId: string, blueprintId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}/blueprints/${blueprintId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `删除蓝图失败：${res.status}`);
  }
}

export interface BlueprintImportResult {
  filename: string;
  text: string;
  text_length: number;
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
    throw new Error(err.detail || `导入失败：${res.status}`);
  }
  return res.json();
}

// ---------- AI 生成任务持久化（页面刷新后恢复"生成中"状态） ----------

export interface AgentTaskStatus {
  id: string;
  agent: string;
  status: "running" | "done" | "error";
  msg: string | null;
  error: string | null;
  started_at: string | null;
  /** 刷新前已流出的文字进度（thinking/draft 累积），刷新后据此恢复流式显示 */
  progress?: { thinking: string; draft: string };
}

export interface AgentRunningTaskResult {
  running: boolean;
  task: AgentTaskStatus | null;
}

/** 查询该小说该角色是否有进行中的生成任务（刷新后恢复生成中状态用）。 */
export async function getAgentRunningTask(
  agent: string,
  novelId: string,
): Promise<AgentRunningTaskResult> {
  const res = await fetch(`${BASE}/stream/agents/${agent}/tasks?novel_id=${novelId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `查询生成任务失败：${res.status}`);
  }
  return res.json();
}

export interface StreamTaskInfo {
  id: string;
  agent: string;
  status: "running" | "done" | "error";
  msg: string | null;
  error: string | null;
  chapter_no: number | null;
  started_at: string | null;
  updated_at: string | null;
}

export interface StreamStatusResult {
  /** 进行中的后台任务（若有） */
  running: StreamTaskInfo | null;
  /** 最近一次任务（done/error，供提示"上次生成结果"） */
  recent: StreamTaskInfo | null;
}

/** 查询该小说最近的 AI 生成任务（含进行中/刚完成）：刷新或切页回来后恢复状态用。 */
export async function getStreamStatus(novelId: string): Promise<StreamStatusResult> {
  const res = await fetch(`${BASE}/stream/agents/status?novel_id=${novelId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `查询生成任务失败：${res.status}`);
  }
  return res.json();
}

export interface OutlineSkeletonModule {
  id: "scale" | "volumes" | "characters" | "plot" | "pacing" | "differentiators";
  ok: boolean;
  reason: string;
  /** 是否选填建议模块：必填四件套为 false；爽点节奏/差异化卖点为 true（缺失不影响生成） */
  optional?: boolean;
}

export interface OutlineSkeletonResult {
  source: "llm" | "deterministic";
  modules: OutlineSkeletonModule[];
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
    throw new Error(detail || `大纲骨架校验失败：${res.status}`);
  }
  return res.json();
}

// ---------- 风格画像（M3：学习 + 版本列表） ----------

export interface StyleProfile {
  id: string;
  novel_id: string;
  version: number;
  traits: {
    sentence_length?: string;
    vocabulary?: string;
    perspective?: string;
    dialogue_ratio?: string;
    rhythm?: string;
    example_fragment?: string;
  } | null;
  avoid_list: string[] | null;
  source_diff_ids: string[] | null;
  updated_at: string;
}

export async function listStyleProfiles(novelId: string): Promise<StyleProfile[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/style`);
  if (!res.ok) throw new Error(`加载风格画像失败：${res.status}`);
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
    throw new Error(err.detail || `风格学习失败：${res.status}`);
  }
  return res.json();
}

// ---------- AI 检测（M4：体检，不阻断） ----------

export interface DetectResult {
  regex_hits: Record<string, number>;
  density: {
    sentences: number;
    avg_sentence_len: number;
    std_sentence_len: number;
    short_ratio: number;
    long_ratio: number;
    commas_per_sentence: number;
    transition_density: number;
    exclamation_ratio: number;
    dialogue_ratio: number;
    stopword_density: number;
  } | null;
  heuristic_score: number;
  burstiness: number | null;
  ppl: number | null;
  verdict: "likely_human" | "mixed" | "likely_ai" | "unknown";
  signals: string[];
  note: string;
}

export async function detectText(novelId: string, text: string): Promise<DetectResult> {
  const res = await fetch(`${BASE}/novels/${novelId}/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `检测失败：${res.status}`);
  }
  return res.json();
}

// ---------- 实体图谱 + 记忆审查（M4） ----------

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  group: number;
  role_rank: string | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type: "dynamic";
  confidence: string;
  chapter_no: number | null;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function getGraph(novelId: string): Promise<GraphView> {
  const res = await fetch(`${BASE}/novels/${novelId}/graph`);
  if (!res.ok) throw new Error(`加载图谱失败：${res.status}`);
  return res.json();
}

export interface MemoryReview {
  progress_chapter: number;
  overdue_foreshadowing: Array<{ id: string; description: string; target_reveal_chapter: number | null; urgency: number | null }>;
  stale_open_hooks: Array<{ id: string; description: string; chapter_introduced: number | null; since: number }>;
  character_states: Record<string, { state: string; chapter_no: number; confidence?: string }>;
  latest_unresolved_hooks: unknown[];
  setting_aliases: { with_aliases: number; merged_duplicates: number };
  total_open: number;
  issues: string[];
  healthy: boolean;
}

export async function getMemoryReview(novelId: string): Promise<MemoryReview> {
  const res = await fetch(`${BASE}/novels/${novelId}/memory-review`);
  if (!res.ok) throw new Error(`加载记忆审查失败：${res.status}`);
  return res.json();
}

// ---------- 模型路由管理（M4） ----------

export interface ModelRoute {
  id: string;
  task_type: "setting" | "creation" | "review" | "extract" | "chat";
  provider: string;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
  context_window: number | null;
  is_default: boolean;
}

export async function listRoutes(): Promise<ModelRoute[]> {
  const res = await fetch(`${BASE}/models/routes`);
  if (!res.ok) throw new Error(`加载模型路由失败：${res.status}`);
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
    throw new Error(err.detail || `保存路由失败：${res.status}`);
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
    throw new Error(err.detail || `更新路由失败：${res.status}`);
  }
  return res.json();
}

export async function deleteRoute(routeId: string): Promise<void> {
  const res = await fetch(`${BASE}/models/routes/${routeId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`删除路由失败：${res.status}`);
}

// ---------- 模型接入（API Key + 默认模型，页面配置，实时生效） ----------

export interface ProviderKeyStatus {
  configured: boolean;
  source: "db" | "env" | null;
  base_url: string | null;
  default_base_url: string;
}

export interface CatalogModel {
  id: string;
  label: string;
}

export interface CatalogProvider {
  provider: string;
  label: string;
  base_url: string;
  key_url: string | null;
  models: CatalogModel[];
  /** 该服务商的多种配置方式（如火山方舟：ark-code-latest 自动 / model-name 指定模型名），弹窗内切换后模型与 base_url 跟着变。 */
  config_modes?: Array<{
    key: string;
    label: string;
    base_url: string;
    hint?: string;
    models: CatalogModel[];
  }>;
  configured: boolean;
  source: "db" | "env" | null;
  note?: string;
  custom?: boolean;
  api_format?: string;
  /** 该服务商已接入的模型清单（一个 Key 可接入多个模型，其中一个是默认）。 */
  enabledModels?: { model: string; label: string }[];
}

/** 预置模型目录：服务商 + 官方地址 + 推荐模型 + Key 状态（对齐后端 MODEL_CATALOG + 自定义模型）。 */
export async function listModelCatalog(): Promise<CatalogProvider[]> {
  const res = await fetch(`${BASE}/models/catalog`);
  if (!res.ok) throw new Error(`加载模型目录失败：${res.status}`);
  return res.json();
}

export interface CustomModelSaveInput {
  label: string;
  api_format: "openai" | "anthropic";
  base_url: string;
  model_id: string;
  api_key: string;
}

export interface CustomModelSaved {
  provider: string;
  model: string;
  label: string;
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
    throw new Error(err.detail || `保存自定义模型失败：${res.status}`);
  }
  return res.json();
}

export async function deleteCustomModel(provider: string): Promise<void> {
  const res = await fetch(`${BASE}/models/custom/${encodeURIComponent(provider)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`删除自定义模型失败：${res.status}`);
}

export interface DefaultModel {
  provider: string;
  model: string;
}

export async function getDefaultModel(): Promise<DefaultModel | null> {
  const res = await fetch(`${BASE}/models/default`);
  if (!res.ok) throw new Error(`加载默认模型失败：${res.status}`);
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
    throw new Error(err.detail || `保存默认模型失败：${res.status}`);
  }
}

export async function listProviderKeys(): Promise<Record<string, ProviderKeyStatus>> {
  const res = await fetch(`${BASE}/models/keys`);
  if (!res.ok) throw new Error(`加载模型接入失败：${res.status}`);
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
    throw new Error(err.detail || `保存失败：${res.status}`);
  }
}

export async function deleteProviderKey(provider: string): Promise<void> {
  const res = await fetch(`${BASE}/models/keys/${encodeURIComponent(provider)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`删除失败：${res.status}`);
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
    throw new Error(err.detail || `接入模型失败：${res.status}`);
  }
}

/** 从已接入清单移除一个模型；若移除的是默认模型则自动改用其他可用模型。 */
export async function removeAccessModel(provider: string, model: string): Promise<void> {
  const res = await fetch(
    `${BASE}/models/access?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`移除模型失败：${res.status}`);
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
    throw new Error(err.detail || `测试连接失败：${res.status}`);
  }
  const data = await res.json();
  return data.models ?? [];
}

// SSE 事件类型（对应后端 pipeline 事件流）
export type StreamEvent =
  | "context_ready"
  | "version_start"
  | "thinking_delta"
  | "stream_delta"
  | "stream_end"
  | "schema_validate"
  | "setting_warning"
  | "stored"
  | "notify"
  | "author_confirm"
  | "stream_error";

/** 设定写后自检命中的疑似漏项（SSE setting_warning）。 */
export interface SettingGap {
  rule: string;
  group: string[];
  present: string[];
  missing: string[];
  source: string;
  /** 命中类型：org_archive_gap=机构档案缺维度（设定卡本身未定档，非本章正文漏写）；缺省=正文必现清单漏写。 */
  kind?: string;
}

export interface StreamEventData {
  event: StreamEvent;
  data: unknown;
}

/** 作者确认请求里的一个候选选项（radio 卡片）。
 * 章节规划采用「逐维度流式咨询」：每次确认只带一个维度的 5 个选项，
 * 选项用 text 展示（选中后作为该维度取值）；作者也可自定义输入该维度。 */
export interface AuthorConfirmOption {
  id: string;
  label?: string;
  desc?: string;
  /** 选项展示文本（章节规划逐维度选项用 text 字段；兼容其它确认的 label 展示） */
  text?: string;
  /** 章节规划（novelist 写正文前咨询「本章规划」）：标题/目标/节奏功能/视角/节拍/结尾钩子 + 写法要点 */
  title?: string;
  goal?: string;
  chapter_function?: string;
  pov?: string;
  beats?: string[];
  ending_hook?: string;
  /** 写法要点（作者选定的"关键场景怎么演"，novelist 照此定向写）： */
  entry?: string; // 核心事件如何进入/点燃
  tone?: string; // 本章风格基调
  protagonist_arc?: string; // 主角态度弧线
  core_conflict?: string; // 核心冲突具体形态
  satisfaction?: string; // 爽点/阅读回报类型
}

/** 场景卡片确认里的一个字段（场景规划）：label + 5 个候选选项，作者逐字段单选/自定义。 */
export interface AuthorConfirmField {
  /** location | participants | goal | conflict | outcome */
  field: string;
  label: string;
  hint?: string;
  options: AuthorConfirmOption[];
}

/** 生成流程内作者确认请求（SSE author_confirm / GET confirm 轮询恢复）。 */
export interface AuthorConfirm {
  id: string;
  novel_id: string;
  /** 所属小说标题（跨小说通知时展示书名；SSE 实时事件里可能没有） */
  novel_title?: string | null;
  /** 发起确认的角色（outliner / era_researcher …） */
  agent: string;
  task_id: string | null;
  confirm_key: string;
  /** pending | answered | dismissed */
  status: string;
  question: string;
  options: AuthorConfirmOption[];
  /** 场景卡片确认（场景规划）：非空时按「场景卡片」渲染（逐字段单选+自定义） */
  fields?: AuthorConfirmField[];
  /** 场景写法提案确认：前端额外提供「都不满意，重新生成」按钮（回传 __regenerate__） */
  regenerable?: boolean;
  /** 是否允许作者自定义输入（大纲方向咨询时开启） */
  allow_custom: boolean;
  answer?: string | null;
  answer_meta?: { label?: string | null; note?: string } | null;
  created_at?: string | null;
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
  if (!res.ok) throw new Error(`查询作者确认请求失败：${res.status}`);
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
    throw new Error(err.detail || `提交作者确认失败：${res.status}`);
  }
  return res.json() as Promise<AuthorConfirm>;
}

/** 作者主动跳过确认点（关闭弹窗）：后端 dismissed，生成任务按默认方向继续。 */
export async function dismissAuthorConfirm(confirmId: string): Promise<void> {
  const res = await fetch(`${BASE}/stream/agents/confirm/${confirmId}/dismiss`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `跳过作者确认失败：${res.status}`);
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
      throw new Error(`请求失败：${res.status}`);
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
    throw new Error(err.detail || `提交失败：${res.status}`);
  }
  return res.json();
}

// ---------- 每部小说独立的写作指令（各创作/评审角色的可配置 System Prompt 片段） ----------

export type WritingPromptField = "mindset" | "style_rules" | "forbidden" | "check_standard";

export interface AgentPrompt {
  key: string;
  name: string;
  /** 是否有自定义记录（false = 当前为内置默认） */
  configured: boolean;
  /** 当前生效的字段（默认值或覆盖后的值；无 check_standard 的角色字段更少） */
  fields: Record<WritingPromptField, string>;
  updated_at: string | null;
}

export async function listPrompts(novelId: string): Promise<AgentPrompt[]> {
  const res = await fetch(`${BASE}/prompts?novel_id=${novelId}`);
  if (!res.ok) throw new Error(`加载写作指令失败：${res.status}`);
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
    throw new Error(err.detail || `保存写作指令失败：${res.status}`);
  }
  return res.json();
}

/** 删除某角色的自定义配置（恢复内置默认）。 */
export async function resetPrompt(novelId: string, agentKey: string): Promise<AgentPrompt> {
  const res = await fetch(`${BASE}/prompts/${agentKey}?novel_id=${novelId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `恢复默认失败：${res.status}`);
  }
  return res.json();
}
