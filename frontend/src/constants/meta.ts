/**
 * @file constants/meta.ts
 * 小说元信息与引导相关共享常量：世界背景类型 BACKGROUND_TYPES、题材预置 GENRE_PRESETS、
 * 新手引导四步 ONBOARDING_STEPS、工作台首次进入路径引导 GUIDE_STEPS。
 * 原定义分别在 novel-meta.tsx / onboarding.tsx / workspace 页内，此处集中维护、多处复用。
 */
import type { Novel } from "@/types/api";
import type { Tab } from "@/types/workspace";

// 世界背景类型：决定签约核查口径（realistic 对照真实时代 / alternate 现实框架+虚构 / pure_fantasy 只查设定账本自洽）。
// 默认不选；不确定可不选，导入蓝图时 AI 按素材推断、作者确认后落库。
export const BACKGROUND_TYPES: { value: Exclude<Novel["background_type"], null>; label: string; hint: string }[] = [
  { value: "realistic", label: "现实年代", hint: "有真实世界参照，核查对照时代细节（如 2000 年扩招、机构命名）" },
  { value: "alternate", label: "半架空", hint: "现实框架 + 虚构元素，虚构部分以设定账本为准" },
  { value: "pure_fantasy", label: "纯架空", hint: "无现实参照（玄幻/仙侠/奇幻），只核查设定账本内部自洽" },
];

// 常见题材预置（软性写作方向指引，可多选；区别于背景类型的硬性核查口径）
export const GENRE_PRESETS = [
  "都市",
  "玄幻",
  "仙侠",
  "奇幻",
  "科幻",
  "历史",
  "同人",
  "重生",
  "穿越",
  "系统",
  "悬疑",
  "灵异",
  "军事",
  "游戏",
  "推理",
  "武侠",
  "言情",
  "甜宠",
  "校园",
  "职场",
];

/** 新手引导步骤的字段结构。 */
export interface OnboardingStep {
  key: string;
  title: string;
  desc: string;
  note: string;
}

/** 与产品里真实的 5 个角色一一对应，不写虚的。 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: "create",
    title: "起个书名",
    desc: "给作品起个名字就能开始，一句话简介可以之后再补。",
    note: "书名随时可改",
  },
  {
    key: "blueprint",
    title: "定下骨架",
    desc: "蓝图师给出主题、核心冲突、角色弧光与伏笔计划，逐版保存，随时可回溯。",
    note: "蓝图是整本书的底稿",
  },
  {
    key: "outline",
    title: "排好章节",
    desc: "大纲师按蓝图排出每章的节拍与冲突，批准后会直接填进写作表单。",
    note: "同时登记伏笔账本",
  },
  {
    key: "write",
    title: "开写正文",
    desc: "小说家生成定稿正文；提取师把它压成记忆，下一章还记得。",
    note: "你的改动会被风格画像学走",
  },
];

/** 首次进入工作台的路径引导步骤：点步骤跳转对应页面（通知保持常驻），✕ 关闭后不再出现。
 *  大纲+章节合并后：写作直接由蓝图出发，写正文前弹「本章规划」确认，不再单独排大纲。 */
export const GUIDE_STEPS: [Tab, string, string][] = [
  ["blueprint", "蓝图", "读设定，定全书骨架"],
  ["write", "写作", "写正文前确认本章规划，直接生成"],
];
