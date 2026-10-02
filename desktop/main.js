/**
 * 笔灵 Biling 桌面壳（Electron 主进程）
 *
 * 职责：
 * 1. 打包模式：拉起内嵌的 FastAPI 后端（resources/backend/backend.exe）与
 *    Next.js standalone 前端（resources/node/node.exe + resources/server/server.js）；
 *    前端经自带 rewrite 代理访问后端（/api/* → 127.0.0.1:8000）。
 * 2. 数据目录 = 程序旁 data\（BILING_DATA_DIR 传给后端），升级覆盖解压不丢数据。
 * 3. 退出时清理子进程；托盘提供「导出日志 / 打开数据目录 / 退出」。
 * 4. 开发模式（npm start，未打包）：假定前后端 dev server 已由开发者启动，只开窗口。
 */
const { app, BrowserWindow, Tray, Menu, dialog, shell, session, net, nativeImage, nativeTheme } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const zlib = require("node:zlib");

const BACKEND_PORT = 8000;
const FRONTEND_PORT = 3000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

let mainWindow = null;
let tray = null;
let children = [];

// ---------- 路径 ----------
function appRoot() {
  // 打包后 = Biling.exe 所在目录（即解压根目录）；开发 = 仓库根目录
  return app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
}
function dataDir() {
  return path.join(appRoot(), "data");
}

// ---------- 子进程生命周期 ----------
function killChildren() {
  for (const c of children) {
    try { c.kill(); } catch (_) { /* 已退出 */ }
  }
  children = [];
}

function startServices() {
  if (!app.isPackaged) return; // 开发模式：开发者自行启动前后端 dev server

  const res = process.resourcesPath;
  const backendExe = path.join(res, "backend", "backend.exe");
  const nodeExe = path.join(res, "node", "node.exe");
  const serverDir = path.join(res, "server");
  const baseEnv = { ...process.env, BILING_DATA_DIR: dataDir() };

  if (fs.existsSync(backendExe)) {
    const p = spawn(backendExe, [], {
      cwd: appRoot(),
      env: { ...baseEnv, BILING_PORT: String(BACKEND_PORT) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => console.log("[backend]", String(d).trimEnd()));
    p.stderr.on("data", (d) => console.error("[backend]", String(d).trimEnd()));
    p.on("exit", (code) => console.error(`[backend] 退出 code=${code}`));
    children.push(p);
  }

  if (fs.existsSync(nodeExe) && fs.existsSync(path.join(serverDir, "server.js"))) {
    const p = spawn(nodeExe, ["server.js"], {
      cwd: serverDir,
      env: { ...baseEnv, PORT: String(FRONTEND_PORT) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => console.log("[server]", String(d).trimEnd()));
    p.stderr.on("data", (d) => console.error("[server]", String(d).trimEnd()));
    p.on("exit", (code) => console.error(`[server] 退出 code=${code}`));
    children.push(p);
  }
}

// ---------- 健康检查 ----------
function waitFor(url, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        clearInterval(timer);
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      });
      req.setTimeout(1500, () => req.destroy());
    };
    const timer = setInterval(tick, 400);
    tick();
  });
}

// ---------- 自绘标题栏：系统原生窗口控制按钮浮层 ----------
// 配色必须与前端自绘标题栏的 --paper 语义色一致（浅色宣纸米白 / 深色暖深灰），
// 这样右上角系统原生按钮区与左侧自绘区域才能无缝衔接。
function windowChromeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: "#1a1815", symbolColor: "#ece4d4" }
    : { color: "#f6f1e6", symbolColor: "#241e17" };
}

// 系统深浅色切换时同步：右上角浮层按钮配色 + 窗口底色（避免加载瞬间闪白）
function applyWindowChrome() {
  if (!mainWindow) return;
  if (process.platform === "win32" && typeof mainWindow.setTitleBarOverlay === "function") {
    mainWindow.setTitleBarOverlay(windowChromeColors());
  }
  mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#1a1815" : "#f6f1e6");
}

// ---------- 窗口 ----------
async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 660,
    title: `笔灵 Biling v${app.getVersion()}`,
    // 自绘标题栏：隐藏系统原生标题栏与菜单栏，内容延伸到窗口顶部；
    // 右上角保留系统原生最小化/最大化/关闭浮层按钮（titleBarOverlay），
    // 按钮由系统绘制并随系统深浅色切换，与前端自绘标题栏配色保持一致
    titleBarStyle: "hidden",
    titleBarOverlay: windowChromeColors(),
    backgroundColor: "#f6f1e6",
    icon: makeIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 预加载脚本把版本号（desktop/package.json 的 version，单一事实源）暴露给页面，
      // 自绘标题栏用它展示 "vX.Y.Z"；值经 additionalArguments 透传，不重复手写
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--biling-version=${app.getVersion()}`],
    },
  });
  // 页面加载后标题会被 document.title 覆盖，这里在标题末尾恒定附加版本号
  // （SPA 切页改标题时也不丢，且不会重复叠加），让用户一眼看到当前版本
  mainWindow.on("page-title-updated", (e, title) => {
    e.preventDefault();
    const ver = `v${app.getVersion()}`;
    const base = title.replace(new RegExp(`\\s*${ver}$`), "");
    mainWindow.setTitle(`${base} ${ver}`);
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(FRONTEND_URL);
}

// ---------- 托盘 ----------
function createTray() {
  tray = new Tray(makeIcon());
  tray.setToolTip(`笔灵 Biling v${app.getVersion()}`);
  const menu = Menu.buildFromTemplate([
    { label: "打开主界面", click: () => showMainWindow() },
    { label: "导出日志…", click: () => exportLogs() },
    { label: "打开数据目录", click: () => shell.openPath(dataDir()) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showMainWindow());
}

function showMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow().catch((e) => console.error(e));
  }
}

// ---------- 导出日志（托盘入口，主进程直接拉取后端接口） ----------
function exportLogs() {
  const req = net.request(`${BACKEND_URL}/api/diagnostics/export`);
  req.on("response", (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      dialog.showErrorBox("导出失败", `后端返回 HTTP ${res.statusCode}`);
      return;
    }
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const buf = Buffer.concat(chunks);
      const name = `biling-logs-${new Date().toISOString().slice(0, 10)}.zip`;
      dialog
        .showSaveDialog(mainWindow || undefined, {
          title: "导出日志",
          defaultPath: path.join(app.getPath("downloads"), name),
          filters: [{ name: "Zip", extensions: ["zip"] }],
        })
        .then(({ canceled, filePath }) => {
          if (canceled || !filePath) return;
          fs.writeFileSync(filePath, buf);
          shell.showItemInFolder(filePath);
        });
    });
  });
  req.on("error", () => dialog.showErrorBox("导出失败", "后端服务未运行，无法导出日志。"));
  req.end();
}

// ---------- 前端「导出日志」按钮触发的下载 → 弹保存对话框 ----------
function registerDownloads() {
  session.defaultSession.on("will-download", (event, item) => {
    if (!item.getFilename().startsWith("biling-logs-")) return;
    event.preventDefault();
    dialog
      .showSaveDialog(mainWindow || undefined, {
        title: "导出日志",
        defaultPath: path.join(app.getPath("downloads"), item.getFilename()),
        filters: [{ name: "Zip", extensions: ["zip"] }],
      })
      .then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          item.cancel();
          return;
        }
        item.setSavePath(filePath);
        item.once("done", (_e, state) => {
          if (state === "completed") shell.showItemInFolder(filePath);
        });
        item.resume();
      });
  });
}

// ---------- 程序化生成占位图标（品牌色，后续可换正式 icon） ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function makePng(size, [r, g, b]) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型：RGB 真彩
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function iconPath() {
  // 打包后：resources/icon.png；开发：desktop/build/icon.png
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, "icon.png");
    return fs.existsSync(p) ? p : null;
  }
  const p = path.join(appRoot(), "desktop", "build", "icon.png");
  return fs.existsSync(p) ? p : null;
}

function makeIcon() {
  const p = iconPath();
  if (p) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  // 兜底：正式图标缺失时用程序化生成的品牌色占位（正常情况下不会走到）
  return nativeImage.createFromBuffer(makePng(32, [183, 71, 42]));
}

// ---------- 启动 ----------
async function boot() {
  await app.whenReady();
  // 移除菜单栏（文件/编辑/查看/帮助等）：自绘标题栏后不再需要，Alt 也无法唤出
  Menu.setApplicationMenu(null);
  // 系统深浅色切换时同步标题栏浮层按钮配色与窗口底色
  nativeTheme.on("updated", applyWindowChrome);
  registerDownloads();
  createTray();
  startServices();

  const [beOk, feOk] = await Promise.all([
    waitFor(`${BACKEND_URL}/api/health`, 60000),
    waitFor(FRONTEND_URL, 60000),
  ]);
  console.log(`后端就绪=${beOk} 前端就绪=${feOk}`);

  await createMainWindow();
  applyWindowChrome(); // 窗口就绪后按当前系统主题刷新一次（覆盖构造时的初值）
  if (!beOk) {
    dialog.showErrorBox("后端启动失败", "本地后端服务未能启动，请查看 data/logs 目录下的日志或重新安装。");
  }
}

// 单实例：重复打开只聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  // 桌面工具：关窗即退出（数据已落盘，无需驻留；托盘仍可兜底）
  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", () => killChildren());

  boot().catch((err) => {
    console.error(err);
    dialog.showErrorBox("启动失败", String((err && err.message) || err));
    app.quit();
  });
}
