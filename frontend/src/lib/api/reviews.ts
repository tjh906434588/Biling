/**
 * @file lib/api/reviews.ts
 * 质量账本接口（评价师产出，/novels/{id}/reviews）。
 */
import { BASE } from "@/constants/api";
import type { QualityReview } from "@/types/api";

/** 某小说的评价列表（可按章过滤），最新在前。 */
export async function listReviews(novelId: string, chapterNo?: number): Promise<QualityReview[]> {
  const qs = chapterNo != null ? `?chapter_no=${chapterNo}` : "";
  const res = await fetch(`${BASE}/novels/${novelId}/reviews${qs}`);
  if (!res.ok) throw new Error("加载评价失败");
  return res.json();
}
