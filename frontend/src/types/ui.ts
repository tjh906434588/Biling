/**
 * @file types/ui.ts
 * 全局 UI 反馈组件（Message / Notification）的共享类型：类型枚举与选项接口。
 * message.tsx / notification.tsx 从本文件引入并 re-export，
 * 保证外部 `import { MessageOptions } from "@/components/message"` 等写法不破坏。
 */
import type { ReactNode } from "react";

/** Message 消息类型：success=成功 / warning=警告 / info=信息 / error=失败。 */
export type MessageType = "success" | "warning" | "info" | "error";

/** Message 消息选项：控制自动消失时长、关闭按钮与关闭回调。 */
export interface MessageOptions {
  /** 自动消失时长（ms），默认 3000；传 0 表示不自动消失 */
  duration?: number;
  /** 是否显示关闭按钮，默认 true */
  closable?: boolean;
  /** 消失（自动或手动关闭）后回调 */
  onClose?: () => void;
}

/** Notification 通知类型：success=成功 / warning=警告 / info=信息 / error=失败。 */
export type NotificationType = "success" | "warning" | "info" | "error";

/** Notification 通知选项：标题/描述/时长/关闭按钮/点击跳转/操作区。 */
export interface NotificationOptions {
  /** 标题（加粗主行，可多行文本） */
  title?: ReactNode;
  /** 描述正文（位于标题下方，可多行换行） */
  message?: ReactNode;
  /** 自动消失时长（ms），默认 4500；传 0 表示不自动消失 */
  duration?: number;
  /** 是否显示右上角关闭按钮，默认 true */
  closable?: boolean;
  /** 消失（自动或手动关闭）后回调 */
  onClose?: () => void;
  /** 点击通知卡片触发（如跳转到对应小说工作台）；设置后整张卡片可点击 */
  onClick?: () => void;
  /** 操作区（按钮等 ReactNode），渲染在描述下方（分隔线之上）；卡片默认不可整体点击时按钮各自响应 */
  actions?: ReactNode;
}
