/**
 * 从 desktop/build/icon.svg 渲染应用图标（多尺寸 PNG + 512px 主图标）。
 *
 * 用法：cd desktop && npm run make:icon
 * 依赖：@resvg/resvg-js（纯预编译，无系统依赖）
 *
 * electron-builder 会用 build/icon.png（512px）自动生成 Windows exe 的 .ico；
 * 桌面壳（托盘/窗口）使用同一份 icon.png。
 */
const { Resvg } = require("@resvg/resvg-js");
const fs = require("node:fs");
const path = require("node:path");

const buildDir = path.join(__dirname, "..", "build");
const svgPath = path.join(buildDir, "icon.svg");
const svg = fs.readFileSync(svgPath, "utf8");

if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
for (const size of sizes) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  fs.writeFileSync(path.join(buildDir, `icon-${size}.png`), png);
}

// 主图标：512px（托盘/窗口/exe 图标统一用这一份）
fs.copyFileSync(path.join(buildDir, "icon-512.png"), path.join(buildDir, "icon.png"));

console.log(`已生成 desktop/build/icon.png 及多尺寸图标（${sizes.join("/")}px）`);
