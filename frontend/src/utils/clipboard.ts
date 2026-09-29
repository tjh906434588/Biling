/**
 * @file utils/clipboard.ts
 * 剪贴板工具：复制文本的通用实现（含降级方案），供各面板共用。
 */
/** 复制文本到剪贴板：优先异步 Clipboard API；权限被拒/不可用（如非 https、iframe 内）时回退 execCommand。 */
export function copyText(text: string): Promise<void> {
  const fallback = () =>
    new Promise<void>((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) resolve();
        else reject(new Error("execCommand copy 失败"));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallback());
  }
  return fallback();
}
