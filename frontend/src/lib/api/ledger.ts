/**
 * @file lib/api/ledger.ts
 * 伏笔账本接口（大纲师登记 + 手动维护 + 超期视图，/novels/{id}/ledger）。
 */
import { BASE } from "@/constants/api";
import type { LedgerItem } from "@/types/api";
import { httpError } from "./errors";

export async function listLedger(
  novelId: string,
  opts?: { status?: string; item_type?: string; overdue_only?: boolean },
): Promise<LedgerItem[]> {
  const p = new URLSearchParams();
  if (opts?.status) p.set("status", opts.status);
  if (opts?.item_type) p.set("item_type", opts.item_type);
  if (opts?.overdue_only) p.set("overdue_only", "true");
  const qs = p.toString();
  const res = await fetch(`${BASE}/novels/${novelId}/ledger${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("加载伏笔账本失败");
  return res.json();
}

export async function listOverdueLedger(novelId: string): Promise<LedgerItem[]> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/overdue`);
  if (!res.ok) throw new Error("加载超期伏笔失败");
  return res.json();
}

export async function updateLedger(
  novelId: string,
  itemId: string,
  data: Partial<Pick<LedgerItem, "description" | "urgency" | "target_reveal_chapter" | "status">>,
): Promise<LedgerItem> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw httpError(err.detail, "更新伏笔失败");
  }
  return res.json();
}

export async function deleteLedger(novelId: string, itemId: string): Promise<void> {
  const res = await fetch(`${BASE}/novels/${novelId}/ledger/${itemId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("删除伏笔失败");
}
