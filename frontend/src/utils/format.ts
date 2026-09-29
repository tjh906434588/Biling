/**
 * @file utils/format.ts
 * 通用格式化工具：时间显示（相对时间、已用时长）等与业务无关的展示格式化集中于此。
 */
/**
 * 相对时间格式化：1 小时内「刚刚」、1 天内「N 小时前」、30 天内「N 天前」，更早显示日期。
 * @param iso ISO 时间字符串；为空或非法时兜底「刚刚」
 */
export function formatDate(iso?: string): string {
  if (!iso) return "刚刚";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "刚刚";
  const diff = Date.now() - d.getTime();
  // 相对时间的判定阈值（ms）：1 小时 / 1 天 / 30 天
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < HOUR) return "刚刚";
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 格式化已用时：不足 1 分钟显示秒（如 37s），满 1 分钟显示分+秒（如 1m05s、2m00s） */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${String(r).padStart(2, "0")}s`;
}
