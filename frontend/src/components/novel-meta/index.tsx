"use client";

/**
 * @file novel-meta.tsx
 * 小说元信息选择器（共享）：世界背景类型单选 + 题材多选。
 * 首页新建/编辑小说与工作台「设定」页复用同一套组件与文案，避免两处定义漂移。
 * 核心机制：紧凑的「分段按钮 / 标签」内联选择，点击即选、再点取消；默认不选，
 * 导入蓝图时由 AI 按素材推断、弹窗引导作者确认。
 * 枚举数据（背景类型/题材预置）全部来自后端 /api/meta 字典（双层字典）：
 * 题材输入即正式入库（POST），自定义题材可删除（DELETE，仅删库中选项，不影响已选题材）。
 */
import { useCallback, useEffect, useState } from "react";
import type { Novel } from "@/lib/api";
import { message } from "@/components/message";
import { addMetaDictItem, deleteMetaDictItem } from "@/lib/api/meta";
import { invalidateMetaDict } from "@/lib/meta-dict";
import {
  loadBackgroundTypes,
  loadGenreAliases,
  loadGenrePresets,
  type BackgroundTypeOption,
  type GenrePresetOption,
} from "@/constants";

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
  /** 背景类型条目（枚举字典，后端单一源；拉取前空数组不渲染） */
  const [types, setTypes] = useState<BackgroundTypeOption[]>([]);
  useEffect(() => {
    void loadBackgroundTypes().then(setTypes);
  }, []);
  /** 当前选中的类型条目，用于展示其说明文案 */
  const current = types.find((t) => t.value === value) ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-3 gap-1.5">
        {types.map((t) => {
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

/* 题材多选：预置标签 + 自定义输入（输入即正式入库），点击即选、再点取消；默认不选 */
/**
 * 题材多选：预置标签 + 自定义输入，点击即选、再点取消。
 * 双层字典：内置预置 + 用户自定义题材都由后端 /api/meta 下发（缓存）；自定义题材输入即正式入库
 * （POST /api/meta/genre_presets/items），库中自定义题材带 ✕ 可删除（DELETE 接口，仅删库中选项）。
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
  /** 题材预置（内置 + 自定义合并，后端单一源） */
  const [presets, setPresets] = useState<GenrePresetOption[]>([]);
  /** 题材同义标签（后端 platform_rules 单一源经接口下发；拉取前为空映射，不影响预置标签选择） */
  const [genreAliases, setGenreAliases] = useState<Record<string, string>>({});
  /** 添加/删除进行中：防连点 */
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void Promise.all([loadGenrePresets(), loadGenreAliases()]).then(([ps, als]) => {
      setPresets(ps);
      setGenreAliases(als);
    });
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  /** 切换某个题材的选中态（选中 ⇄ 取消）。 */
  const toggle = (g: string) => {
    onChange(value.includes(g) ? value.filter((x) => x !== g) : [...value, g]);
  };
  /** 把输入框内容正式入库并选中（输入即正式入库，无临时态；空值或已选中时忽略）。 */
  const addCustom = async () => {
    const g = custom.trim();
    if (!g || busy) return;
    if (value.includes(g)) {
      setCustom("");
      return;
    }
    setBusy(true);
    try {
      await addMetaDictItem("genre_presets", g);
      invalidateMetaDict("genre_presets"); // 立即失效缓存，下一次访问拉到最新
      setPresets((prev) => (prev.some((p) => p.value === g) ? prev : [...prev, { value: g, label: g, custom: true }]));
      onChange([...value, g]);
      setCustom("");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** 把库中的自定义题材删除（仅删库中选项，不影响已选题材）。 */
  const removeFromLibrary = async (g: string) => {
    if (busy || !window.confirm(`把「${g}」从题材库删除？已选中的书不受影响，只是以后不再作为预置选项。`)) return;
    setBusy(true);
    try {
      await deleteMetaDictItem("genre_presets", g);
      invalidateMetaDict("genre_presets");
      setPresets((prev) => prev.filter((p) => p.value !== g));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** 输入命中已知同义标签（与后端题材族匹配同步）且标准标签未选中 → 提示改用标准标签 */
  const aliasTarget = custom.trim() ? genreAliases[custom.trim()] : undefined;
  /** 已选但不在题材库里的（历史遗留/手动加的），单独展示可取消选择 */
  const presetValues = presets.map((p) => p.value);
  const orphanSelected = value.filter((g) => !presetValues.includes(g));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => {
          const active = value.includes(p.value);
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => toggle(p.value)}
              className={`rounded-md border px-2 py-0.5 text-[11.5px] transition-colors ${
                active
                  ? "border-zinc-500 bg-zinc-800 text-white dark:border-zinc-400 dark:bg-zinc-200 dark:text-zinc-900"
                  : "border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {p.label}
              {p.custom && (
                <span
                  role="button"
                  tabIndex={-1}
                  title="从题材库删除"
                  className="ml-1 cursor-pointer text-zinc-400 hover:text-red-500"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeFromLibrary(p.value);
                  }}
                >
                  ✕
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* 已选但不在题材库里的（历史数据）也展示出来，可取消选择 */}
      {orphanSelected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {orphanSelected.map((g) => (
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
          className="w-28 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11.5px] text-zinc-800 outline-none focus:border-zinc-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          placeholder="自定义题材"
          value={custom}
          maxLength={12}
          disabled={busy}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addCustom();
            }
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void addCustom()}
          className="text-[11.5px] text-zinc-500 hover:text-zinc-700 disabled:opacity-60"
        >
          + 添加
        </button>
      </div>
      {/* 同义提示：输入命中已知同义标签时引导改用标准标签（后端题材族匹配按标准标签命中） */}
      {aliasTarget && !value.includes(aliasTarget) && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-4 text-zinc-500">
          <span>「{custom.trim()}」与标准标签「{aliasTarget}」同义，</span>
          <button
            type="button"
            className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10.5px] leading-none text-white hover:opacity-80 dark:bg-zinc-100 dark:text-zinc-900"
            onClick={() => {
              if (!aliasTarget) return;
              onChange([...value, aliasTarget]);
              setCustom("");
            }}
          >
            改用「{aliasTarget}」
          </button>
          <span>·</span>
          <button type="button" className="hover:underline" disabled={busy} onClick={() => void addCustom()}>
            仍用「{custom.trim()}」
          </button>
        </div>
      )}
    </div>
  );
}
