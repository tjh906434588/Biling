/**
 * @file constants/agents.ts
 * AI 角色相关共享常量。角色中文名以「后端唯一权威源」为主（app/agents/roles.py，经 /api/agents/meta
 * 下发，见 lib/api/agents.ts 的 getAgentMeta），本文件只保留一份「本地兜底」FALLBACK_ROLE_NAMES
 * （首屏/离线时先用），并暴露 loadAgentLabels / getAgentLabel 供全局读取——全项目一律通过
 * getAgentLabel 取角色名，不再各自维护中文名。
 * 另含：作者确认轮询间隔 CONFIRM_POLL_INTERVAL、工作台 tools 调试页的角色注册表 AGENTS。
 */

import { getAgentMeta } from "@/lib/api";

/** 本地兜底角色名（首屏/接口不可用时先用；接口拉取成功后覆盖，见 loadAgentLabels）。
 *  命名与后端 roles.py 保持一致，改动务必同步两处并以后端为准。 */
const FALLBACK_ROLE_NAMES: Record<string, string> = {
  blueprint_architect: "蓝图架构师",
  blueprint_activation: "蓝图激活",
  blueprint_prechecker: "蓝图导入质检师",
  import_checker: "导入质检师",
  outliner: "大纲师",
  outline_checker: "大纲质检师",
  direction_proposer: "提案师",
  era_researcher: "研究员",
  chapter_planner: "章节规划师",
  scene_planner: "场景规划师",
  novelist: "小说家",
  reviser: "修订师",
  critic: "评价师",
  extractor: "状态提取师",
  setting_extractor: "设定提取师",
  style_extractor: "文风提取师",
  memory_keeper: "作品编年师",
};

/** 远程角色名缓存（getAgentMeta 拉取后写入；null = 未拉取/失败，回退本地兜底）。 */
let remoteRoleNames: Record<string, string> | null = null;

/** 应用启动时调用一次：拉取后端权威角色名，失败静默保持本地兜底。 */
export async function loadAgentLabels(): Promise<void> {
  try {
    remoteRoleNames = await getAgentMeta();
  } catch {
    remoteRoleNames = null; // 拉取失败：继续用本地兜底，不影响功能
  }
}

/** 取角色中文名：远程优先，本地兜底，未知角色回退英文 key。 */
export function getAgentLabel(key: string): string {
  return (remoteRoleNames ?? FALLBACK_ROLE_NAMES)[key] ?? key;
}

/** 作者确认轮询间隔（ms）：刷新/断线后靠 GET /confirm 轮询恢复未答复确认。 */
export const CONFIRM_POLL_INTERVAL = 3000;

/** 表单字段类型（tools 调试页参数表单）：文本/长文本/数字/下拉。 */
export type ParamType = "text" | "textarea" | "number" | "select";

/** 表单字段规格：驱动 tools 页参数表单的渲染、校验与提交转换 */
export interface ParamSpec {
  key: string; // 传给后端的字段名
  label: string; // 中文标签
  placeholder?: string; // 输入框占位提示（不预填内容）
  type: ParamType;
  default?: string | number; // 仅 select 使用（下拉框必须有选中项）
  optional?: boolean;
  required?: boolean; // 必填：为空时阻止运行并提示
  options?: { value: string; label: string }[];
}

/** 六角色注册表：角色名 / 描述 / 参数表单规格（tools 页选择角色后据此渲染表单）。
 *  角色名统一走 getAgentLabel（单一源），desc 仅调试页展示用。 */
export const AGENTS: Record<string, { name: string; desc: string; params: ParamSpec[] }> = {
  blueprint_architect: {
    name: getAgentLabel("blueprint_architect"),
    desc: "搭建整部作品的世界蓝图（规则/人物弧光/分卷/伏笔计划）",
    params: [
      {
        key: "requirements",
        label: "创作要求",
        placeholder: "例如：悬疑奇幻，主题是记忆与身份，主角是记忆被篡改的占卜师之子",
        type: "textarea",
        required: true,
      },
    ],
  },
  outliner: {
    name: getAgentLabel("outliner"),
    desc: "为某一章产出细化大纲（节拍/冲突/伏笔处理）",
    params: [
      { key: "chapter_no", label: "章节号", placeholder: "如 1（留空则排下一章）", type: "number" },
      {
        key: "chapter_titles",
        label: "已写章节标题",
        placeholder: "如：雨夜铜币, 通缉令…（逗号分隔，可留空）",
        type: "text",
        optional: true,
      },
    ],
  },
  novelist: {
    name: getAgentLabel("novelist"),
    desc: "按大纲生成章节正文（单版本，生成即定稿，见「写作」页）",
    params: [
      { key: "chapter_no", label: "章节号", placeholder: "如 1（留空则排下一章）", type: "number" },
      { key: "title", label: "章名", placeholder: "如 雨夜铜币", type: "text" },
      { key: "pov", label: "视角角色", placeholder: "如 林澈（这章跟谁走）", type: "text" },
      {
        key: "chapter_function",
        label: "章节功能",
        type: "select",
        default: "buildup",
        options: [
          { value: "buildup", label: "铺垫" },
          { value: "progression", label: "推进" },
          { value: "climax", label: "高潮" },
          { value: "turning", label: "转折" },
          { value: "interlude", label: "过渡" },
        ],
      },
      {
        key: "writing_mode",
        label: "写作模式",
        type: "select",
        default: "draft_free",
        options: [
          { value: "draft_free", label: "自由初稿（写到哪算哪）" },
          { value: "outline_guided", label: "按大纲走（完成目标）" },
        ],
      },
      {
        key: "outline",
        label: "本章大纲",
        placeholder: "粘贴本章大纲（留空则自由续写）…",
        type: "textarea",
      },
      {
        key: "goal",
        label: "本章目标",
        placeholder: "如 引入铜币并建立通缉危机（可留空）",
        type: "text",
        optional: true,
      },
    ],
  },
  extractor: {
    name: getAgentLabel("extractor"),
    desc: "从章节正文提取故事状态，写入记忆层（真实入库 story_state）",
    params: [
      { key: "chapter_no", label: "章节号", placeholder: "如 1", type: "number" },
      {
        key: "chapter_text",
        label: "本章正文",
        placeholder: "粘贴本章正文，AI 从中提取故事状态…",
        type: "textarea",
        required: true,
      },
      {
        key: "prev_state",
        label: "上一章状态",
        placeholder: "上一章故事状态（可留空）",
        type: "textarea",
        optional: true,
      },
    ],
  },
  critic: {
    name: getAgentLabel("critic"),
    desc: "对照蓝图/伏笔账本评价章节质量，反哺小说家",
    params: [
      {
        key: "outline",
        label: "本章大纲",
        placeholder: "粘贴本章大纲（对照评价用）…",
        type: "textarea",
      },
      {
        key: "chapter_text",
        label: "待评价的正文",
        placeholder: "粘贴待评价的章节正文…",
        type: "textarea",
        required: true,
      },
      {
        key: "writing_mode",
        label: "写作模式",
        type: "select",
        default: "draft_free",
        options: [
          { value: "draft_free", label: "自由初稿" },
          { value: "outline_guided", label: "按大纲走" },
        ],
      },
    ],
  },
};
