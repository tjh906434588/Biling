/**
 * @file components/settings/import-modal.tsx
 * 「批量导入设定」弹窗（由 settings-panel.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——导入文本、解析结果、导入忙碌态与全部动作
 * （复制指令 / 解析预览 / 确认导入 / 关闭）均由父组件下发；解析纯函数见 import.tsx。
 */
"use client";

import Modal from "../modal";
import { orderStages } from "./timing";
import { STAGE_STYLE, TYPE_LABEL } from "./settings-utils";
import { STAGE_LABEL } from "@/constants";
import type { ImportItem } from "./import";

interface Props {
  open: boolean;
  importText: string;
  onImportTextChange: (v: string) => void;
  parsed: ImportItem[] | null;
  importBusy: boolean;
  onCopy: () => void;
  onParse: () => void;
  onImport: () => void;
  onClose: () => void;
}

/** 「批量导入设定」弹窗：先复制指令发给外部 AI，粘贴其输出 → 解析预览 → 一键批量添加。 */
export default function ImportModal({
  open,
  importText,
  onImportTextChange,
  parsed,
  importBusy,
  onCopy,
  onParse,
  onImport,
  onClose,
}: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="批量导入设定"
      subtitle="先复制指令发给外部 AI（豆包 / DeepSeek 等），再把它的输出粘贴回来，一键批量添加进设定集。"
      maxWidth="max-w-xl"
      regionScroll
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <button className="btn btn-ghost w-full shrink-0 px-3 py-1.5 text-xs" onClick={onCopy}>
          复制导入指令
        </button>
        <textarea
          className="w-full shrink-0 resize-y rounded-lg border border-zinc-300 bg-zinc-50 p-2 text-[12px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          rows={10}
          placeholder='把 AI 输出的设定清单粘贴到这里（含类型、名称、固定信息与可变信息），可直接复制，无需手动编辑'
          value={importText}
          onChange={(e) => onImportTextChange(e.target.value)}
        />
        <button className="btn btn-ghost w-full shrink-0 px-3 py-1.5 text-xs" onClick={onParse} disabled={!importText.trim()}>
          解析预览
        </button>

        {parsed && parsed.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {parsed.map((it, i) => (
                <li key={i} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {TYPE_LABEL[it.type]}
                    </span>
                    <span className="truncate text-xs font-medium">{it.name}</span>
                    {orderStages(it.stages).map((st) => (
                      <span
                        key={st}
                        className={`rounded px-1 py-0.5 text-[10px] ${
                          STAGE_STYLE[st] ?? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                        }`}
                      >
                        {STAGE_LABEL[st] ?? st}
                      </span>
                    ))}
                    {(() => {
                      const ranges =
                        it.appear_ranges && it.appear_ranges.length
                          ? it.appear_ranges
                          : it.appear_from !== null || it.appear_until !== null
                            ? [{ from: it.appear_from, until: it.appear_until }]
                            : [];
                      if (!ranges.length) return null;
                      return (
                        <span className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          第{ranges.map((r) => `${r.from ?? "?"}–${r.until ?? "终"}`).join("、")}章生效
                        </span>
                      );
                    })()}
                  </div>
                  {it.constitution && (
                    <p className="mt-0.5 truncate text-[11px] text-amber-700 dark:text-amber-300">不可变：{it.constitution}</p>
                  )}
                  {it.dynamic && (
                    <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">可变：{it.dynamic}</p>
                  )}
                </li>
              ))}
            </ul>
            <button className="btn btn-primary shrink-0 px-3 py-2 text-xs" onClick={onImport} disabled={importBusy}>
              {importBusy ? "导入中…" : `确认导入（${parsed.length} 条）`}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
