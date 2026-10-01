"use client";

/**
 * @file novel-meta.tsx
 * 小说元信息选择器（共享）：世界背景类型单选 + 题材多选。
 * 首页新建/编辑小说与工作台「设定」页复用同一套组件与文案，避免两处定义漂移。
 * 核心机制：紧凑的「分段按钮 / 标签」内联选择，点击即选、再点取消；默认不选，
 * 导入蓝图时由 AI 按素材推断、弹窗引导作者确认。
 */
import { useState } from "react";
import type { Novel } from "@/lib/api";
import { BACKGROUND_TYPES, GENRE_PRESETS } from "@/constants";

/* 世界背景类型：分段按钮单选；点击已选项可取消（回到未选择），默认不选 */
/**
 * 世界背景类型选择器（分段按钮单选，点已选项可取消回未选择）。
 * @param value 当前值；undefined = 未选择。
 * @param onChange 回传新值（取消选择时为 undefined）。
 */
export function BackgroundTypePicker({
  value,
  onChange,
}: {
  value: Novel["background_type"];
  onChange: (v: Novel["background_type"]) => void;
}) {
  /** 当前选中的类型条目，用于展示其说明文案 */
  const current = BACKGROUND_TYPES.find((t) => t.value === value) ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-3 gap-1.5">
        {BACKGROUND_TYPES.map((t) => {
          const active = value === t.value;
          return (
            <button
              key={t.value}
              type="button"
              title={t.hint}
              onClick={() => onChange(active ? undefined : t.value)}
              className={`rounded-lg border px-2 py-1.5 text-[12px] font-medium transition-colors ${
                active
                  ? "border-zinc-800 bg-zinc-800 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-500 hover:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-400"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-4 text-zinc-400">
        {current ? current.hint : "不选也没关系，AI 会根据你的故事背景帮你选，再让你确认"}
      </p>
    </div>
  );
}

/* 题材多选：预置标签 + 自定义输入，点击即选、再点取消；默认不选 */
/**
 * 题材多选：预置标签 + 自定义输入，点击即选、再点取消。
 * @param value 已选题材数组。
 * @param onChange 回传更新后的题材数组。
 */
export function GenrePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  /** 自定义题材输入框的临时文本 */
  const [custom, setCustom] = useState("");
  /** 切换某个题材的选中态（选中 ⇄ 取消）。 */
  const toggle = (g: string) => {
    onChange(value.includes(g) ? value.filter((x) => x !== g) : [...value, g]);
  };
  /** 把输入框内容添加为自定义题材（空值或已存在时忽略）。 */
  const addCustom = () => {
    const g = custom.trim();
    if (!g || value.includes(g)) return;
    onChange([...value, g]);
    setCustom("");
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {GENRE_PRESETS.map((g) => {
          const active = value.includes(g);
          return (
            <button
              key={g}
              type="button"
              onClick={() => toggle(g)}
              className={`rounded-md border px-2 py-0.5 text-[11.5px] transition-colors ${
                active
                  ? "border-zinc-500 bg-zinc-800 text-white dark:border-zinc-400 dark:bg-zinc-200 dark:text-zinc-900"
                  : "border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {g}
            </button>
          );
        })}
      </div>
      {/* 已选的自定义题材（不在预置列表里的）也展示出来 */}
      {value.some((g) => !GENRE_PRESETS.includes(g)) && (
        <div className="flex flex-wrap gap-1.5">
          {value
            .filter((g) => !GENRE_PRESETS.includes(g))
            .map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => toggle(g)}
                className="rounded-md border border-zinc-500 bg-zinc-100 px-2 py-0.5 text-[11.5px] text-zinc-700 dark:border-zinc-400 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {g} ✕
              </button>
            ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11.5px] text-zinc-800 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          placeholder="自定义题材"
          value={custom}
          maxLength={12}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button type="button" onClick={addCustom} className="text-[11.5px] text-zinc-500 hover:text-zinc-700">
          + 添加
        </button>
      </div>
    </div>
  );
}
