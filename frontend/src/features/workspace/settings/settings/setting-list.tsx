/**
 * @file components/settings/setting-list.tsx
 * 「设定列表」主工作区（由 settings-panel.tsx 按逻辑边界拆分）：
 * 纯展示 + 回调，不持有任何 state——列表数据（全量与筛选后）、搜索词、类型筛选、空态判断
 * 均由父组件下发；每条设定卡片（SettingCard，本文件内部组件）只负责按类型/来源/阶段/角色等级
 * 渲染标签与不可变/可变两栏文案，编辑/删除按钮回传回调。
 */
"use client";

import InfoTip from "../info-tip";
import { SETTING_TYPES, STAGE_LABEL } from "@/constants";
import { orderStages } from "./timing";
import { splitSetting, settingMeta } from "./helpers";
import { ROLE_RANK_LABEL, ROLE_RANK_STYLE, STAGE_STYLE, TYPE_LABEL } from "./settings-utils";
import type { Setting } from "@/lib/api";

interface Props {
  /** 全量设定（筛选前），用于区分「还没有任何设定」与「筛选无结果」两种空态。 */
  settings: Setting[];
  /** 筛选后的展示列表。 */
  visibleSettings: Setting[];
  q: string;
  onQChange: (v: string) => void;
  typeFilter: string;
  onTypeFilterChange: (v: string) => void;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (s: Setting) => void;
  onDelete: (s: Setting) => void;
}

/** 单条设定卡片：类型/来源/阶段/章范围/角色等级标签 + 不可变/可变两栏文案 + 编辑/删除。 */
function SettingCard({ s, onEdit, onDelete }: { s: Setting; onEdit: (s: Setting) => void; onDelete: (s: Setting) => void }) {
  const { con, dyn } = splitSetting(s);
  const meta = settingMeta(s);
  return (
    <li className="rounded-lg bg-sunken/40 p-3.5 dark:bg-sunken/30">
      <div className="flex items-center gap-2">
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {TYPE_LABEL[s.type] ?? s.type}
        </span>
        {s.source === "blueprint" && (
          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[11px] text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
            蓝图导入
          </span>
        )}
        {s.source === "outline" && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
            来自大纲
          </span>
        )}
        <span className="text-sm font-medium">{s.name}</span>
        {orderStages(meta.stages).map((st) => (
          <span
            key={st}
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              STAGE_STYLE[st] ?? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {STAGE_LABEL[st] ?? st}
          </span>
        ))}
        {meta.ranges.length > 0 && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            第{meta.ranges.map((r) => `${r.from ?? "?"}–${r.until ?? "终"}`).join("、")}章生效
          </span>
        )}
        {s.type === "character" &&
          (() => {
            const st = (s.structured ?? {}) as Record<string, unknown>;
            const rk = typeof st.role_rank === "string" ? st.role_rank : "";
            if (!rk) return null;
            return (
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  ROLE_RANK_STYLE[rk] ?? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
              >
                {ROLE_RANK_LABEL[rk] ?? rk}
              </span>
            );
          })()}
        <div className="ml-auto flex items-center gap-1">
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => onEdit(s)}>
            编辑
          </button>
          <button className="btn btn-ghost px-2 py-1 text-xs text-red-500" onClick={() => onDelete(s)}>
            删除
          </button>
        </div>
      </div>
      {(con || dyn) && (
        <div className="mt-1.5 flex flex-col gap-1">
            {con && (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                <span className="mr-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                  不可变
                </span>
                {con}
              </p>
            )}
            {dyn && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                <span className="mr-1.5 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  可变
                </span>
                {dyn}
              </p>
            )}
          </div>
      )}
    </li>
  );
}

/** 设定列表主工作区：标题 + 计数 + 操作按钮 + 搜索/类型筛选 + 列表（或空态）。 */
export default function SettingList({
  settings,
  visibleSettings,
  q,
  onQChange,
  typeFilter,
  onTypeFilterChange,
  onAdd,
  onImport,
  onEdit,
  onDelete,
}: Props) {
  return (
    <section className="panel flex min-h-0 flex-1 flex-col gap-3.5">
      <div className="panel-head mb-0">
        <div className="flex items-center gap-1.5">
          <h3 className="panel-title">设定列表</h3>
          <InfoTip width="w-80" side="bottom">
            <p>
              <span className="font-medium text-zinc-800 dark:text-zinc-100">设定 = 这本小说的「设定集」。</span>
              AI 写每一章前都会读一遍。角色、地点、世界规则都记在这里；「不可变」栏的内容 AI 绝对不会改，其余可以随剧情发展。先写主角一条就能开笔，边写边补。
            </p>
          </InfoTip>
        </div>
        <div className="flex items-center gap-2">
          <span className="panel-hint">
            共 {visibleSettings.length} 条
            {typeFilter ? ` · 只看「${TYPE_LABEL[typeFilter] ?? typeFilter}」` : ""}
          </span>
          <button type="button" className="btn btn-ghost px-3 py-1.5 text-xs" onClick={onImport}>
            批量导入
          </button>
          <button type="button" className="btn btn-primary px-3 py-1.5 text-xs" onClick={onAdd}>
            新增设定
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          className="flex-1 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          placeholder="搜索名称/描述…"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
        />
        <div className="flex gap-1 overflow-x-auto">
          <button
            className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
              typeFilter === ""
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "border border-zinc-300 hover:border-zinc-500 dark:border-zinc-700"
            }`}
            onClick={() => onTypeFilterChange("")}
          >
            全部
          </button>
          {SETTING_TYPES.map((t) => (
            <button
              key={t}
              className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                typeFilter === t
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-zinc-300 hover:border-zinc-500 dark:border-zinc-700"
              }`}
              onClick={() => onTypeFilterChange(t)}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {visibleSettings.length === 0 ? (
        settings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm leading-6 text-zinc-400 dark:border-zinc-700">
            还没有设定。点击「新增设定」先加一条，建议从主角开始：
            <br />
            选择「角色」→ 名称写「岚」→ 在「可变」栏写一句外貌、性格和目的。
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm leading-6 text-zinc-400 dark:border-zinc-700">
            还没有任何设定。点右上角「新增设定」自己加一条。
            <br />
            可以先手动加一条。
          </div>
        )
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          {visibleSettings.map((s) => (
            <SettingCard key={s.id} s={s} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </section>
  );
}
