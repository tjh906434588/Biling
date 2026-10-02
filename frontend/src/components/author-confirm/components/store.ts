/**
 * @file store.ts
 * 作者确认机制的模块级 store：待确认队列 + 内嵌宿主计数 + 订阅分发。
 * 关键机制：模块级单例（跨 tab 常驻，刷新后经 GET /confirm 轮询恢复）+ SSE author_confirm
 * 事件实时推入；生成过程弹窗内嵌展示时全局弹窗自动让位，避免重复打扰。
 * author-confirm.tsx 仅做 re-export，所有消费方（弹窗宿主 / 内嵌宿主 / 轮询通知中心）共享本文件同一份状态。
 */
import { fetchPendingConfirms, type AuthorConfirm } from "@/lib/api";

/** 待确认队列条目（沿用后端 AuthorConfirm 结构）。 */
type ConfirmEntry = AuthorConfirm;

/** 订阅者集合：弹窗宿主 / 内嵌宿主订阅队列变化以重渲染。 */
const listeners = new Set<() => void>();
/** 待确认队列（模块级共享，跨 tab 常驻；SSR 服务端快照恒为空）。 */
let queue: ConfirmEntry[] = [];

/** 已随「生成过程弹窗」内嵌展示过的确认 id：这些确认不再作为独立全局弹窗弹出。
 * 同一确认只打扰作者一次——生成弹窗关闭后（流结束/超时/作者关弹窗）它若仍未答复，
 * 按「作者忽略」处理，后端确认点超时自动 dismissed，下次恢复/切换小说时从队列清掉。 */
const inlineShownIds = new Set<string>();

/** SSR 服务端快照：恒为空，且必须引用稳定（否则 "getServerSnapshot should be cached" 无限循环警告） */
export const EMPTY_CONFIRM_SNAPSHOT: ConfirmEntry[] = [];
export const EMPTY_INLINE_SNAPSHOT: ReadonlyMap<string, number> = new Map();

/** 通知所有订阅者：队列已变化。 */
function emit() {
  listeners.forEach((l) => l());
}

export function subscribeAuthorConfirms(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAuthorConfirms(): ConfirmEntry[] {
  return queue;
}

/** 写入一条确认：新确认追加到队尾，已存在则合并字段，并通知订阅者。 */
function upsert(confirm: AuthorConfirm) {
  const i = queue.findIndex((c) => c.id === confirm.id);
  if (i >= 0) {
    // 已存在：合并新字段并生成新数组（保证引用变化，useSyncExternalStore 才能触发重渲染）
    queue = queue.map((c, idx) => (idx === i ? { ...c, ...confirm } : c));
  } else {
    queue = [...queue, confirm];
  }
  emit();
}

/** SSE author_confirm 事件推入（生成流程实时弹窗）。
 * 推入时若该小说已有生成弹窗在运行（内嵌宿主活跃），确认将随弹窗内嵌展示，
 * 打上「已内嵌展示」标记，全局弹窗宿主随后跳过它——避免同一确认内嵌+独立弹窗重复弹。 */
export function pushAuthorConfirm(confirm: AuthorConfirm) {
  if ((inlineHostCount.get(confirm.novel_id) ?? 0) > 0) {
    inlineShownIds.add(confirm.id);
  }
  upsert(confirm);
}

function removeConfirm(id: string) {
  queue = queue.filter((c) => c.id !== id);
  inlineShownIds.delete(id);
  emit();
}
/** 供生成过程弹窗等内嵌宿主移除已答复的确认。 */
export { removeConfirm };

/** 该确认是否已随「生成过程弹窗」内嵌展示过（全局弹窗宿主据此跳过，避免重复打扰）。 */
export function isInlineShown(id: string): boolean {
  return inlineShownIds.has(id);
}

/** ── 内嵌确认宿主：生成过程弹窗（AgentStreamModal）打开且正在生成时注册，全局弹窗让位 ──
 * 计数按 novelId 累加/递减：同一小说可能同时开多个生成弹窗（写作页的生成/评价/优化），
 * 只要有一个在运行，确认就应内嵌其中展示，避免再叠一层全局 Modal（层级被覆盖 / 误关其它弹窗）。 */
const inlineHostCount = new Map<string, number>();
const inlineHostListeners = new Set<() => void>();
/** 缓存快照：每次变化替换为新 Map（引用变化，useSyncExternalStore 才能触发重渲染） */
let inlineHostSnapshot: ReadonlyMap<string, number> = inlineHostCount;
function emitInlineHost() {
  inlineHostListeners.forEach((l) => l());
}
export function subscribeInlineHosts(listener: () => void): () => void {
  inlineHostListeners.add(listener);
  return () => {
    inlineHostListeners.delete(listener);
  };
}
export function getInlineHostCount(): ReadonlyMap<string, number> {
  return inlineHostSnapshot;
}
/** 生成弹窗打开且运行中：+1；关闭/停止/卸载：-1。计数归零自动移除。 */
export function setInlineHost(novelId: string, active: boolean) {
  const cur = inlineHostCount.get(novelId) ?? 0;
  const next = active ? cur + 1 : Math.max(0, cur - 1);
  if (next === 0) inlineHostCount.delete(novelId);
  else inlineHostCount.set(novelId, next);
  inlineHostSnapshot = new Map(inlineHostCount);
  emitInlineHost();
}

/** 刷新 / 切换小说后从后端恢复待确认项（去重合并；切走的小说残留项清掉）。 */
export async function restoreAuthorConfirms(novelId: string): Promise<void> {
  try {
    const items = await fetchPendingConfirms(novelId);
    const ids = new Set(items.map((i) => i.id));
    queue = queue.filter((c) => c.novel_id !== novelId || ids.has(c.id));
    for (const it of items) {
      // 重新恢复 = 新上下文（进入/切回时通常没有生成弹窗打开）：清掉「已内嵌展示」标记，
      // 允许全局弹窗宿主或内嵌宿主重新向作者展示
      inlineShownIds.delete(it.id);
      upsert(it);
    }
    emit();
  } catch {
    // 查询失败静默（后端未就绪 / 网络抖动），下次进入再试
  }
}
