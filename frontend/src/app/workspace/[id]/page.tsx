/**
 * @file app/workspace/[id]/page.tsx
 * 工作台路由页：页面逻辑在 features/workspace，这里仅解析路由参数（Next.js 要求页面文件在 app/）
 * 后转发 novelId；tab 与 URL 的同步、各面板挂载等均在 features/workspace/index.tsx 内完成。
 */
"use client";

import { use } from "react";
import Workspace from "@/features/workspace";

export default function WorkspaceRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Workspace novelId={id} />;
}
