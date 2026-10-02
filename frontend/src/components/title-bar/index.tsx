/**
 * @file title-bar.tsx
 * 桌面版自绘窗口标题栏：整条作为系统拖拽区（可拖窗、双击最大化），
 * 右上角留白给系统原生窗口控制按钮浮层（Windows 约 138px 宽，由 Electron
 * titleBarOverlay 绘制，无需也不应在 DOM 中复刻）。
 * 关键机制：-webkit-app-region: drag 提供拖窗能力；配色走 --paper / zinc 语义色，
 * 自动跟随系统深浅色，与主进程 titleBarOverlay 的按钮区配色保持一致。
 * 版本号由 preload 脚本经 contextBridge 暴露（window.biling.version，单一事实源
 * = desktop/package.json 的 version），标题右侧展示 "vX.Y.Z"；
 * useEffect 内读取是为了避开 Next 静态预渲染时 window 不存在导致的 hydration 不一致。
 * 浏览器环境（非 Electron）下本组件无副作用，仅多一条 32px 的装饰条。
 */
"use client";

import { useEffect, useState } from "react";

/** 桌面壳 preload 经 contextBridge 暴露的全局信息（见 desktop/preload.js） */
declare global {
  interface Window {
    biling?: { version?: string };
  }
}

export default function TitleBar() {
  const [ver, setVer] = useState("");

  useEffect(() => {
    setVer(window.biling?.version ?? "");
  }, []);

  return (
    <div className="titlebar flex h-8 shrink-0 select-none items-center gap-2.5 border-b border-zinc-200 bg-paper pl-3 text-[12px] dark:border-zinc-800">
      <span className="font-serif font-medium tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
        笔灵 Biling
      </span>
      {ver ? (
        <span className="rounded-full bg-zinc-200/70 px-2 py-[2px] font-mono text-[10px] leading-none text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          v{ver}
        </span>
      ) : null}
      {/* 右上角预留系统原生窗口控制按钮浮层区域（勿放交互元素，保持 no-drag） */}
      <span className="no-drag ml-auto h-full w-[140px]" aria-hidden />
    </div>
  );
}
