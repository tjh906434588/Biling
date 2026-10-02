/**
 * @file types/api.ts
 * 领域/API 共享类型：后端接口返回的结构化数据、SSE 事件与作者确认的类型定义集中于此。
 * 原散落在 src/lib/api.ts 中，重构时按「类型集中管理」惯例抽到 types/ 目录；
 * lib/api.ts 通过 `export * from "@/types/api"` 向后兼容，业务代码仍可从 "@/lib/api" 导入这些类型。
 * 注意：SettingType 引用常量 SETTING_TYPES（来自 "@/constants/api"），task_type 引用 TASK_TYPES
 * （来自 "@/constants/task-types"），保证「常量即类型」单一事实来源。
 */
import { SETTING_TYPES } from "@/constants/api";
import type { TaskType } from "@/constants/task-types";

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
  rubric:
    | Record<string, { score?: number; comment?: string; evidence?: string; hooks?: Record<string, number> }>
    | null;
  issues: Array<{ severity?: string; type?: string; desc?: string; suggested_fix?: string }> | null;
  strengths: string[] | null;
  revision_hints: string[] | null;
  created_at: string;
}

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

export interface ApproveOutlineResult {
  /** true=已在后台启动批准注入（前端轮询批准状态直到成功/失败）；false=已生效/无需批准 */
  running: boolean;
  task_id: string | null;
  outline_id: string;
  chapter_no: number;
  version_no: number;
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

export type LedgerType = "setup" | "thread" | "character_state" | "location_state" | "unresolved_hook";

export type LedgerStatus = "open" | "closed" | "abandoned";

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

export interface OutlineTemplate {
  version: string;
  text: string;
}

export interface ActivateBlueprintResult {
  /** true=已在后台启动激活（前端轮询激活状态直到成功/失败）；false=已生效/无需激活 */
  running: boolean;
  task_id: string | null;
  blueprint_id: string;
  version: number;
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

export interface BlueprintImportResult {
  filename: string;
  text: string;
  text_length: number;
}

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

export interface ModelRoute {
  id: string;
  task_type: TaskType;
  provider: string;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
  context_window: number | null;
  is_default: boolean;
}

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
  /** 该服务商已用有效 Key 刷新过模型列表（live=true 时 models 为账号真实模型，非静态种子）。 */
  live?: boolean;
  live_updated_at?: string;
  /** 该服务商已接入的模型清单（一个 Key 可接入多个模型，其中一个是默认）。 */
  enabledModels?: { model: string; label: string }[];
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

export interface DefaultModel {
  provider: string;
  model: string;
}

// SSE 事件类型（对应后端 pipeline 事件流）
export type StreamEvent =
  | "context_ready"
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
