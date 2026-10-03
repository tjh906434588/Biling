/**
 * @file constants/meta.ts
 * 小说元信息与引导相关共享常量：世界背景类型/题材预置已迁移为枚举字典（后端 /api/meta 单一源，
 * 见 loadBackgroundTypes / loadGenrePresets），新手引导四步 ONBOARDING_STEPS、工作台首次进入
 * 路径引导 GUIDE_STEPS 为固定文案，前端写死。
 */
import type { Tab } from "@/types/workspace";
import { loadMetaDict } from "@/lib/meta-dict";

/** 世界背景类型条目（枚举字典下发：value + label + hint；列表顺序即展示顺序）。 */
export interface BackgroundTypeOption {
  value: "realistic" | "alternate" | "pure_fantasy";
  label: string;
  hint: string;
}

/** 拉取世界背景类型（后端 meta.py 单一源，统一缓存命中不再请求）；失败回退内置静态兜底。 */
export async function loadBackgroundTypes(): Promise<BackgroundTypeOption[]> {
  try {
    return await loadMetaDict<BackgroundTypeOption[]>("background_types");
  } catch {
    return [
      { value: "realistic", label: "现实年代", hint: "有真实世界对照，AI 会检查时代细节对不对（如 2000 年扩招、机构命名）" },
      { value: "alternate", label: "半架空", hint: "大部分真实，加一些虚构设定" },
      { value: "pure_fantasy", label: "纯架空", hint: "完全虚构的世界（玄幻/仙侠/奇幻），只要设定前后不矛盾就行" },
    ];
  }
}

/** 题材预置条目（枚举字典下发：value + label；含用户自定义题材，双层字典，后端单一源）。 */
export interface GenrePresetOption {
  value: string;
  label: string;
  /** 是否为用户自定义项（内置枚举无此标记）；自定义项可经 DELETE 从库中删除。 */
  custom?: boolean;
}

/** 拉取题材预置（内置 + 用户自定义合并，统一缓存）；失败回退空数组（自定义输入仍可用）。 */
export async function loadGenrePresets(): Promise<GenrePresetOption[]> {
  try {
    return await loadMetaDict<GenrePresetOption[]>("genre_presets");
  } catch {
    return [];
  }
}

/** 题材同义标签 → 标准标签：单一事实源在后端 app/agents/platform_rules.py 的 GENRE_ALIASES，
 * 前端经 /api/meta（统一字典接口 + 缓存）拉取（见 loadGenreAliases），不在此再维护一份，避免改后端忘同步前端。 */
export async function loadGenreAliases(): Promise<Record<string, string>> {
  try {
    return await loadMetaDict<Record<string, string>>("genre_aliases");
  } catch {
    return {};
  }
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
