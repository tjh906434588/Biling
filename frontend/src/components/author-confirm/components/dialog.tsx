/**
 * @file dialog.tsx
 * 单条作者确认的全局弹窗外壳：Modal + 确认面板。
 * 关键机制：点 ✕ = 跳过（通知后端解除阻塞，避免轮询每 3 秒把弹窗重新推回来）；
 * 纯受控展示组件，confirm / onSettled 由宿主（author-confirm/host.tsx）传入，答复后由宿主出队。
 */
"use client";

import Modal from "../../modal";
import { dismissAuthorConfirm, type AuthorConfirm } from "@/lib/api";
import { AGENT_LABELS } from "@/constants";
import { ConfirmPanel } from "./panel";

interface ConfirmDialogProps {
  confirm: AuthorConfirm | null;
  onSettled: (id: string) => void;
}

/** 单条确认的全局弹窗外壳：Modal + 确认面板；点 ✕ = 跳过（通知后端解除阻塞，避免轮询重新推回）。 */
export function ConfirmDialog({ confirm, onSettled }: ConfirmDialogProps) {
  if (!confirm) return null;
  return (
    <Modal
      open
      title={`${AGENT_LABELS[confirm.agent] ?? confirm.agent} · 请你确认`}
      subtitle="写到这停一下，你拍板后继续"
      onClose={() => {
        // 点关闭 = 跳过：通知后端解除确认阻塞，避免轮询每 3 秒把弹窗重新推回来
        void dismissAuthorConfirm(confirm.id).catch(() => {});
        onSettled(confirm.id);
      }}
      maxWidth="max-w-xl"
    >
      <ConfirmPanel confirm={confirm} onSettled={onSettled} />
    </Modal>
  );
}
