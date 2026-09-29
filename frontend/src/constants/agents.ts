/**
 * @file constants/agents.ts
 * AI 角色相关共享常量：角色中文标签 AGENT_LABELS（合并自 agent-task-toasts.tsx 与 author-confirm.tsx
 * 两份定义，取其并集，各调用方按需取 key）、作者确认轮询间隔 CONFIRM_POLL_INTERVAL，
 * 以及工作台 tools 调试页的角色注册表 AGENTS（含其局部类型 ParamType/ParamSpec）。
 */

/** AI 角色 → 中文标签（后台任务悬浮框/确认弹窗标题用，与各面板的叫法保持一致）。
 *  注意：author-confirm.tsx 另有仅用于「规划详情展示」的 FUNCTION_LABELS（节奏功能标签），
 *  与本文件的 AGENT_LABELS 无关；且其值与大纲页派生版本存在差异（如 buildup 蓄势/铺垫），
 *  为避免改变展示文案，FUNCTION_LABELS 保持在各组件内，不在此合并。 */
export const AGENT_LABELS: Record<string, string> = {
  blueprint_architect: "蓝图师",
  blueprint_activation: "蓝图激活",
  outliner: "大纲师",
  novelist: "小说家",
  reviser: "修订师",
  critic: "评价师",
  extractor: "记忆层",
  setting_extractor: "设定抽取",
  era_researcher: "时代·行业研究员",
  blueprint_prechecker: "蓝图质检师",
  chapter_planner: "章节规划师",
  scene_planner: "场景规划师",
};

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

/** 六角色注册表：角色名 / 描述 / 参数表单规格（tools 页选择角色后据此渲染表单） */
export const AGENTS: Record<string, { name: string; desc: string; params: ParamSpec[] }> = {
  blueprint_architect: {
    name: "蓝图师",
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
    name: "大纲师",
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
    name: "小说家",
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
    name: "提取师",
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
    name: "评价师",
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
