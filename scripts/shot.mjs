/**
 * 用 Chrome DevTools Protocol 做可控截图：
 *   node shot.mjs <url> <out.png> [width] [height] [waitExpr] [fullPage]
 * 解决 headless --screenshot 等不到客户端 fetch / 入场动画的问题。
 */
import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, w = "1600", h = "1000", waitExpr = "!document.querySelector('.animate-pulse')", fullPage = "1"] =
  process.argv.slice(2);

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("找不到 Chrome/Edge");

const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "cdp-shot-"));

const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-prefers-reduced-motion",
    ...(process.env.NOPROXY === "1" ? ["--no-proxy-server"] : []),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=800,600",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === "page");
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error("调试端口未就绪");
}

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }
    }, 30000);
  });
}

try {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Log.entryAdded") {
      console.error(`[log.${m.params.entry.level}]`, m.params.entry.text, m.params.entry.url ?? "");
    }
    if (m.method === "Runtime.exceptionThrown") {
      console.error("[page-exception]", m.params.exceptionDetails?.text, m.params.exceptionDetails?.exception?.description ?? "");
    }
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      console.error(`[console.${m.params.type}]`, m.params.args?.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };

  await send(ws, "Page.enable");
  await send(ws, "Runtime.enable");
  await send(ws, "Log.enable").catch(() => {});
  await send(ws, "Emulation.setDeviceMetricsOverride", {
    width: Number(w),
    height: Number(h),
    deviceScaleFactor: Number(w) <= 500 ? 2 : 1,
    mobile: Number(w) <= 500,
  });

  if (process.env.DARK === "1") {
    await send(ws, "Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
  }

  await send(ws, "Page.navigate", { url });

  // 等待 waitExpr 为真（最多 20s）
  let ok = false;
  for (let i = 0; i < 66; i++) {
    await sleep(300);
    try {
      const r = await send(ws, "Runtime.evaluate", {
        expression: waitExpr,
        returnByValue: true,
      });
      if (r.result?.value === true) {
        ok = true;
        break;
      }
    } catch {}
  }
  if (!ok) console.error("[warn] 等待条件超时，按当前状态截图");

  if (process.env.PROBE) {
    try {
      const r = await send(ws, "Runtime.evaluate", {
        expression: process.env.PROBE,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log("[probe]", JSON.stringify(r.result?.value));
    } catch (e) {
      console.error("[probe-error]", e.message);
    }
  }

  const shot = await send(ws, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: fullPage === "1",
  });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`saved: ${out}`);
  ws.close();
} finally {
  proc.kill();
  await sleep(200);
}
