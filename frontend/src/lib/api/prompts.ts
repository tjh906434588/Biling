/**
 * @file lib/api/prompts.ts
 * 每部小说独立的写作指令接口（各创作/评审角色的可配置 System Prompt 片段，/prompts）。
 */
import { BASE } from "@/constants/api";
import type { AgentPrompt, WritingPromptField } from "@/types/api";
import { httpError } from "./errors";

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
