/**
 * @file agent-labels-loader.tsx
 * 应用启动时拉取一次「角色中文名」权威映射（后端 /api/agents/meta），
 * 让全项目任务通知/确认弹窗/调试页显示的角色名与后端 roles.py 保持完全一致。
 */
"use client";

import { useEffect } from "react";
import { loadAgentLabels } from "@/constants/agents";

export default function AgentLabelsLoader() {
  useEffect(() => {
    void loadAgentLabels();
  }, []);
  return null;
}
