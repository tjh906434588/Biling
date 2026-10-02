/**
 * @file preload.js
 * Electron 渲染进程预加载脚本（contextIsolation + sandbox 模式下仍可用）：
 * 通过 contextBridge 向页面暴露桌面壳信息（版本号），供自绘标题栏展示。
 * 版本号单一事实源 = desktop/package.json 的 version，由主进程
 * app.getVersion() 读取后经 additionalArguments（--biling-version=）传入，
 * 这里只做透传，不在任何地方手写版本号。
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("biling", {
  version:
    process.argv.find((a) => a.startsWith("--biling-version="))?.split("=")[1] ?? "",
});
