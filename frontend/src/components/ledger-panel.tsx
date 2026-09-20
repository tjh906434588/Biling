"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LEDGER_TYPE_LABELS,
  listLedger,
  type LedgerItem,
} from "@/lib/api";
import { message } from "@/components/message";
import Loading from "@/components/loading";

interface Props {
  novelId: string;
}

function urgencyColor(u: number | null): string {
  if (u == null) return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800";
  if (u >= 8) return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
  if (u >= 5) return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800";
}

export default function LedgerPanel({ novelId }: Props) {
  const [items, setItems] = useState<LedgerItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listLedger(novelId));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openItems = items.filter((i) => i.status === "open");
  const closedItems = items.filter((i) => i.status !== "open");
  const overdue = openItems.filter((i) => i.overdue);
  const staleOnly = openItems.filter((i) => i.stale && !i.overdue);

  function renderItem(item: LedgerItem) {
    return (
      <li
        key={item.id}
        className={`rounded-lg border p-3 ${
          item.overdue
            ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950"
            : "border-zinc-200 dark:border-zinc-800"
        }`}
      >
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {LEDGER_TYPE_LABELS[item.item_type] ?? item.item_type}
          </span>
          {item.urgency != null && (
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${urgencyColor(item.urgency)}`}>
              紧迫度 {item.urgency}
            </span>
          )}
          {item.overdue && (
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-medium text-white">
              已超期
            </span>
          )}
          {item.stale && !item.overdue && (
            <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-medium text-white">
              久未回收
            </span>
          )}
          {item.chapter_resolved != null && (
            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700 dark:bg-green-900 dark:text-green-300">
              第{item.chapter_resolved}章回收
            </span>
          )}
        </div>
        <p className="text-sm text-zinc-800 dark:text-zinc-200">{item.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span>埋于第{item.chapter_introduced ?? "?"}章</span>
          {item.target_reveal_chapter != null && <span>目标揭示第{item.target_reveal_chapter}章</span>}
          {item.related_entity && <span>关联：{item.related_entity}</span>}
        </div>
      </li>
    );
  }

  return (
    <Loading loading={loading}>
      <div className="flex flex-col gap-5">
      {/* 预警横幅：超期（红）+ 久未回收（琥珀），账本页是伏笔状态的唯一专页出口 */}
      {(overdue.length > 0 || staleOnly.length > 0) && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            overdue.length > 0
              ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          }`}
        >
          {overdue.length > 0 && (
            <span>
              <span className="font-semibold">伏笔超期预警：</span>
              {overdue.length} 条伏笔已写到目标揭示章仍未回收。
            </span>
          )}
          {staleOnly.length > 0 && (
            <span className={overdue.length > 0 ? "ml-2" : ""}>
              <span className="font-semibold">久未回收：</span>
              {staleOnly.length} 条伏笔已搁置超 5 章。
            </span>
          )}
          <span className={overdue.length > 0 || staleOnly.length > 0 ? "ml-2" : ""}>写作时优先处理，否则读者会丢失线索。</span>
        </div>
      )}

      {/* open / closed 泳道 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel flex h-[calc(100dvh-6rem)] flex-col">
          <div className="panel-head shrink-0">
            <h4 className="panel-title">
              待回收
              <span className="text-xs font-normal text-zinc-400">{openItems.length}</span>
            </h4>
          </div>
          {openItems.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
              暂无未回收伏笔。
            </p>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{openItems.map(renderItem)}</ul>
          )}
        </section>
        <section className="panel flex h-[calc(100dvh-6rem)] flex-col">
          <div className="panel-head shrink-0">
            <h4 className="panel-title">
              已回收
              <span className="text-xs font-normal text-zinc-400">{closedItems.length}</span>
            </h4>
          </div>
          {closedItems.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400 dark:border-zinc-700">
              暂无已回收伏笔。
            </p>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{closedItems.map(renderItem)}</ul>
          )}
        </section>
      </div>
      </div>
    </Loading>
  );
}
