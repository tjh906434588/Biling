/**
 * @file utils/storage.ts
 * localStorage 键构造工具：跨页面/跨模块使用的持久化键名统一在此生成，避免各处硬编码散落。
 */
export function rewriteFailDataKey(novelId: string) {
  return `biling.rewriteFail.${novelId}.data`;
}
export function rewriteFailRemainingKey(novelId: string) {
  return `biling.rewriteFail.${novelId}.remaining`;
}
