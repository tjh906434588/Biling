/**
 * @file constants/meta.ts
 * 小说元信息与引导相关共享常量：世界背景类型 BACKGROUND_TYPES、题材预置 GENRE_PRESETS、
 * 新手引导四步 ONBOARDING_STEPS、工作台首次进入路径引导 GUIDE_STEPS。
 * 原定义分别在 novel-meta.tsx / onboarding.tsx / workspace 页内，此处集中维护、多处复用。
 */
import type { Novel } from "@/types/api";
import type { Tab } from "@/types/workspace";
import { getGenreAliases } from "@/lib/api";

// 世界背景类型：决定签约核查口径（realistic 对照真实时代 / alternate 现实框架+虚构 / pure_fantasy 只查设定账本自洽）。
// 默认不选；不确定可不选，导入蓝图时 AI 按素材推断、作者确认后落库。
export const BACKGROUND_TYPES: { value: Exclude<Novel["background_type"], null>; label: string; hint: string }[] = [
  { value: "realistic", label: "现实年代", hint: "有真实世界对照，AI 会检查时代细节对不对（如 2000 年扩招、机构命名）" },
  { value: "alternate", label: "半架空", hint: "大部分真实，加一些虚构设定" },
  { value: "pure_fantasy", label: "纯架空", hint: "完全虚构的世界（玄幻/仙侠/奇幻），只要设定前后不矛盾就行" },
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

// 题材同义标签 → 标准标签：单一事实源在后端 app/agents/platform_rules.py 的 GENRE_ALIASES，
// 前端经 GET /api/novels/genre-aliases 拉取（见 loadGenreAliases），不在此再维护一份，避免改后端忘同步前端。

/** 题材同义标签模块级缓存（接口拉取一次；失败回退空映射，不阻塞输入）。 */
let genreAliasesCache: Record<string, string> | null = null;

/** 拉取题材同义标签（后端单一源）：设定页自定义题材输入命中同义标签时提示改用标准标签。 */
export async function loadGenreAliases(): Promise<Record<string, string>> {
  if (genreAliasesCache) return genreAliasesCache;
  try {
    genreAliasesCache = await getGenreAliases();
  } catch {
    genreAliasesCache = {};
  }
  return genreAliasesCache;
}

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
    desc: "AI 帮你定主题、冲突、主角成长线和伏笔安排，保存后随时能改回旧版本",
    note: "蓝图是整本书的底稿",
  },
  {
    key: "outline",
    title: "排好章节",
    desc: "AI 排好每章的节奏和冲突，你点头后直接用于写作",
    note: "同时记进伏笔记录",
  },
  {
    key: "write",
    title: "开写正文",
    desc: "AI 写出正文并记住剧情，下一章不会前后矛盾。",
    note: "你改的地方，它也会学着你的风格写",
  },
];

/** 首次进入工作台的路径引导步骤：点步骤跳转对应页面（通知保持常驻），✕ 关闭后不再出现。
 *  大纲+章节合并后：写作直接由蓝图出发，写正文前弹「本章规划」确认，不再单独排大纲。 */
export const GUIDE_STEPS: [Tab, string, string][] = [
  ["blueprint", "蓝图", "读设定，定全书骨架"],
  ["write", "写作", "写正文前确认本章规划，直接生成"],
];
