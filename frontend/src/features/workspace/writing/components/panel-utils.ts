/**
 * @file writing/panel-utils.ts
 * 写作面板（writing-panel.tsx）的模块级纯函数与类型：
 * - GenForm/EMPTY_FORM：新增/重新生成章节弹窗表单类型与初始值（chapter_no 默认 1，与大纲页一致）；
 * - AiRunState：AI 运行过程状态（thinking=思考过程 / output=正式输出 / running=进行中），
 *   供「查看 AI 过程」弹窗流式展示；
 * - InfoDraft：信息控制弹窗的本地草稿（「完成」才提交到 form，「取消」丢弃）；
 * - ConfirmDialogState：定稿/提取记忆层的二次确认弹窗配置；
 * - ShowToast：面板统一提示回调签名（success/warning/error → 全局 message）；
 * - summarizeOutline：把已批大纲压缩成一段摘要（可作 outline 参数 / 评价对照，不含标题）；
 * - validateExtractFor：提取记忆层前置校验（有章/有版本/非旧大纲/已定稿）的共用文案，
 *   「弹确认前」与「确认后执行」两处复用以保证判断与提示一致。
 */

import type { ChapterListItem, ChapterVersion, Outline } from "@/lib/api";

/** 新增/重新生成章节弹窗表单：章号/标题/大纲目标/章节功能（打开弹窗时重置）。
 *  「谁知道了什么」信息控制已改为本书级全局配置（novels/info-control），不再逐章存于表单。 */
export interface GenForm {
  chapter_no: number;
  title: string;
  outline: string;
  chapter_function: string;
  goal: string;
}

export const EMPTY_FORM: GenForm = {
  chapter_no: 1,
  title: "",
  outline: "",
  chapter_function: "", // 留空 = 由小说家按剧情节奏自动判定（与大纲页一致）
  goal: "",
};

/** AI 运行过程状态：供「查看 AI 过程」弹窗流式展示（thinking=思考过程 / output=正式输出）。 */
export interface AiRunState {
  thinking: string;
  output: string;
  running: boolean;
}

/** 信息控制弹窗的本地草稿（完成才提交到 form，取消丢弃）。 */
export interface InfoDraft {
  reader_knows: string;
  protagonist_knows: string;
  must_hide: string;
  hint_only: string;
}

/** 二次确认弹窗（定稿 / 提取记忆层）配置：kind 区分语义，savedText 为定稿/提取前已落盘的正文。 */
export interface ConfirmDialogState {
  kind: "finalize" | "finalize-force" | "extract";
  /** 定稿前已落盘保存的正文（flushSave 结果）；null=无编辑或保存失败 */
  savedText: string | null;
}

/** 面板统一提示回调签名：success/warning/error 三级，走全局 message API。 */
export type ShowToast = (msg: string, level?: "success" | "warning" | "error") => void;

/** 将已批大纲压缩成一段可作 outline 参数 / 评价对照的摘要（不含标题，标题单独成字段）。 */
export function summarizeOutline(o: Outline): string {
  const c = (o.content ?? {}) as {
    goal?: string;
    beats?: Array<{ content?: string }>;
    plant_foreshadowing?: Array<{ desc?: string; latest_payoff_chapter?: number }>;
    resolve_foreshadowing?: Array<{ how?: string }>;
  };
  const parts: string[] = [];
  if (c.goal) parts.push(`目标：${c.goal}`);
  if (c.beats?.length) parts.push(`节拍：${c.beats.map((b) => b.content).filter(Boolean).join("；").slice(0, 400)}`);
  if (c.plant_foreshadowing?.length) parts.push(`埋设：${c.plant_foreshadowing.map((p) => p.desc).join("、")}`);
  if (c.resolve_foreshadowing?.length) parts.push(`回收：${c.resolve_foreshadowing.map((r) => r.how).join("、")}`);
  return parts.join("\n");
}

/** 提取记忆层前置校验：返回错误提示文案（null=通过）。供「弹确认前」与「确认后执行」两处复用。 */
export function validateExtractFor(
  activeChapter: ChapterListItem | null,
  selectedVersion: ChapterVersion | null,
  isStaleForActiveOutline: boolean,
  selectedIsFinal: boolean,
): string | null {
  if (!activeChapter) return "请先在章节目录选择一章";
  if (!selectedVersion) return "该章尚未选定版本，无法提取。请先完成生成与选定。";
  if (isStaleForActiveOutline)
    return "当前正文基于旧版大纲生成，只能查看，不能记进 AI 记忆。请先基于当前正在用的大纲重新生成一份正文，再定稿并记进 AI 记忆。";
  if (!selectedVersion.content.trim()) return "正文为空，不能提取记忆。请先补充正文。";
  if (!selectedIsFinal)
    return "只有已定稿的正文才能记进 AI 记忆。请先在「本章操作」点「定稿」，再点「记进 AI 记忆」。";
  return null;
}
