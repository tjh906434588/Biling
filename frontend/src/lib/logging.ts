/**
 * @file lib/logging.ts
 * 前端日志：全局捕获未处理错误 / 未处理 Promise 拒绝，并批量上报后端 POST /api/logs，
 * 落盘到 data/logs/frontend.log，供「导出日志」功能打包排查问题（后端 app/api/diagnostics.py）。
 *
 * 设计：内存缓冲 + 定时/满额批量上报（keepalive），失败静默不打扰用户。
 */
import { BASE } from "@/constants/api";

type Level = "info" | "warn" | "error";

interface LogLine {
  ts: string;
  level: Level;
  msg: string;
}

const MAX_BUFFER = 50; // 攒够 50 条立即上报
const FLUSH_INTERVAL_MS = 5000; // 每 5 秒兜底上报一次
const MAX_MSG_LEN = 4000; // 单条上限，防刷爆日志文件

let buffer: LogLine[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function push(level: Level, msg: string): void {
  const text = msg.length > MAX_MSG_LEN ? msg.slice(0, MAX_MSG_LEN) : msg;
  buffer.push({ ts: new Date().toISOString(), level, msg: text });
  if (buffer.length >= MAX_BUFFER) void flush();
  if (timer == null) timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await fetch(`${BASE}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: batch }),
      keepalive: true,
    });
  } catch {
    // 上报失败静默：日志功能不能反过来打扰用户
  }
}

/** 统一日志入口：info / warn / error / errorFrom（异常对象 → 可读文本）。 */
export const log = {
  info: (msg: string) => push("info", msg),
  warn: (msg: string) => push("warn", msg),
  error: (msg: string) => push("error", msg),
  errorFrom: (context: string, err: unknown) =>
    push(
      "error",
      `${context}: ${
        err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : safeStringify(err)
      }`,
    ),
};

/** 全局兜底：安装一次，捕获未处理错误与未处理 Promise 拒绝。 */
export function initGlobalLogging(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __bilingLoggingInit?: boolean };
  if (w.__bilingLoggingInit) return;
  w.__bilingLoggingInit = true;

  window.addEventListener("error", (e) => {
    log.errorFrom("window.onerror", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    log.errorFrom("unhandledrejection", e.reason);
  });
  window.addEventListener("beforeunload", () => {
    void flush();
  });
}
