/**
 * @file writing/source-label.ts
 * 章节版本来源标签：统一维护远程字典标签与本地兜底。
 */

import { loadSourceLabels } from "@/constants";

let remoteSourceLabels: Record<string, string> = {};

export async function loadSourceLabelsOnce(): Promise<void> {
  try {
    remoteSourceLabels = await loadSourceLabels();
  } catch {
    remoteSourceLabels = {};
  }
}

void loadSourceLabelsOnce();

export function sourceLabel(source: string): string {
  if (source.startsWith("novelist")) return "初稿";
  return (
    remoteSourceLabels[source] ??
    ({
      novelist: "初稿",
      regenerate: "再稿",
      reviser: "修订稿",
      user_edit: "人工",
      manual_rewrite: "人工",
      expanded: "AI 扩写",
      merged: "手动合并",
    } as Record<string, string>)[source] ??
    "未知来源"
  );
}
