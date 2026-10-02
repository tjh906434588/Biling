/**
 * @file layout.tsx
 * Next.js 根布局：应用外壳（字体、全局样式、meta / viewport）。
 * 核心机制：全局挂载 AI 状态 Provider（AiStatusProvider）与三套悬浮提示体系
 * （Message 居中 / Notification 右上角 / 作者确认提醒），所有页面共享同一上下文与提示通道；
 * 字体用纯本地系统栈（globals.css 的 --sans-stack，不依赖外网字体下载）。
 */
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AiStatusProvider } from "@/lib/ai-status";
import { MessageHost } from "@/components/message";
import { NotificationHost } from "@/components/notification";
import { ConfirmNotifier } from "@/components/author-confirm";
import GlobalLogging from "@/components/global-logging";
import TitleBar from "@/components/title-bar";

/** 全局 SEO / 浏览器标签页元信息：标题模板、描述、应用名 */
export const metadata: Metadata = {
  title: {
    default: "笔灵 Biling · AI 小说写作伙伴",
    template: "%s · 笔灵",
  },
  description:
    "能记住你的世界、理解你的角色、随故事推进而成长的 AI 写作伙伴。蓝图、大纲、正文、记忆、评价，五个角色陪你写完一部长篇。",
  applicationName: "笔灵 Biling",
};

/** 移动端视口设置 + 主题色：让浏览器地址栏/状态栏融入纸色背景 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 让浏览器地址栏/状态栏也融入纸色，减少「网页」感
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f1e6" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1815" },
  ],
};

/** 根布局组件：包裹全局 Provider 与悬浮提示宿主，children 为当前路由页面 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex h-dvh flex-col overflow-hidden">
        {/* 桌面版自绘窗口标题栏（Electron 隐藏系统标题栏后的拖拽区；浏览器里仅一条装饰条） */}
        <TitleBar />
        <AiStatusProvider>{children}</AiStatusProvider>
        {/* 全局前端日志：捕获未处理错误并上报后端落盘（导出日志排查问题用） */}
        <GlobalLogging />
        {/* 全局悬浮提示体系：Message（居中靠上）/ Notification（右上角），页面内统一走这两个全局 API */}
        <MessageHost />
        <NotificationHost />
        {/* 全局作者确认提醒中心：跨小说轮询，任意小说的生成流程停在确认点时右上角提醒并支持点击跳转 */}
        <ConfirmNotifier />
      </body>
    </html>
  );
}
