import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AiStatusProvider } from "@/lib/ai-status";
import { MessageHost } from "@/components/message";
import { NotificationHost } from "@/components/notification";
import { ConfirmNotifier } from "@/components/author-confirm";

// Geist 只提供拉丁字形，中文由 globals.css 中的 --sans-stack 回退链接管
// （Noto Sans SC / 苹方 / 微软雅黑），避免引入体积巨大的中文字体包。
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "笔灵 Biling · AI 小说写作伙伴",
    template: "%s · 笔灵",
  },
  description:
    "能记住你的世界、理解你的角色、随故事推进而成长的 AI 写作伙伴。蓝图、大纲、正文、记忆、评价，五个角色陪你写完一部长篇。",
  applicationName: "笔灵 Biling",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 让浏览器地址栏/状态栏也融入纸色，减少「网页」感
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f1e6" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1815" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AiStatusProvider>{children}</AiStatusProvider>
        {/* 全局悬浮提示体系：Message（居中靠上）/ Notification（右上角），页面内统一走这两个全局 API */}
        <MessageHost />
        <NotificationHost />
        {/* 全局作者确认提醒中心：跨小说轮询，任意小说的生成流程停在确认点时右上角提醒并支持点击跳转 */}
        <ConfirmNotifier />
      </body>
    </html>
  );
}
