/**
 * @file lib/api/errors.ts
 * API 错误处理工具：把 fetch 错误响应 / 运行期异常转成用户可读的中文文案。
 * 各域接口文件从这里引入 httpError；业务侧可直接用 friendlyRunError / friendlyTaskError。
 */

/** 把 fetch 的错误响应 detail 包装成友好错误（英文 detail / 空 detail → 中文兜底，隐藏裸 HTTP 状态码）。 */
export function httpError(detail: unknown, fallback: string): Error {
  return new Error(friendlyTaskError(detail ? String(detail) : "", fallback));
}

/** 把运行期异常转成对用户友好的提示：网络层中断（长等待时连接被代理/网关掐断）给出可操作建议。 */
export function friendlyRunError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return "等待 AI 响应超时，已自动中断显示。生成任务可能仍在后台继续，请稍后刷新页面查看结果；若反复超时，可重试。";
  }
  if (/terminated|load failed|network error|fetch failed|aborted|chunked|ECONNRESET|socket|timed out/i.test(raw)) {
    return "网络连接中断，生成未完成。输入内容已保留，请直接重试；若反复失败，可把导入文档精简后重试。";
  }
  return raw;
}

/** 把 AI 任务/接口返回的错误转成用户可读文案：
 *  后端错误本身是中文 → 原样展示；空值/纯英文/状态码等技术信息 → 统一用中文兜底，避免用户看到裸英文或 HTTP 码。 */
export function friendlyTaskError(err?: string | null, fallback = "AI 任务执行出错，请稍后重试。"): string {
  if (!err || !String(err).trim()) return fallback;
  const s = String(err).trim();
  return /[\u4e00-\u9fff]/.test(s) ? s : fallback;
}
