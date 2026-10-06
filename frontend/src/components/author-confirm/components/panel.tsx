/**
 * @file panel.tsx
 * 作者确认面板：问题 + 候选选项（单选）+ 自定义输入 + 补充说明 + 操作按钮。
 * 关键机制：章节规划为「逐维度流式咨询」——每次确认只展示一个维度的 3 个选项（+1 个自定义输入），
 * 选定后后端带着前面的选择再生成下一个维度；场景规划走「场景卡片」模式（一张卡 = 一个场景的多字段，
 * 逐字段单选/自定义，全部填完提交，后端拼进场景执行清单）。
 * 面板自身管理表单状态，答复/跳过/重新生成通过 onSettled 回调通知宿主出队；既可作为全局确认弹窗
 * 的内容，也可内嵌进生成过程弹窗（embedded）随生成过程一起展示。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import {
  dismissAuthorConfirm,
  submitAuthorConfirm,
  type AuthorConfirm,
  type AuthorConfirmField,
} from "@/lib/api";
import { loadFunctionLabels } from "@/constants";

/** 内嵌进生成内容模块时的卡片外壳：色系与内容统一（灰阶），仅用更深的底色/边框
 * 与模块背景区分，配合上方的琥珀色标题突出"需要手动选择"。 */
const EMBEDDED_SHELL_CLASS =
  "flex shrink-0 flex-col gap-3 rounded-lg border border-zinc-300 bg-zinc-100/80 p-3.5 dark:border-zinc-600 dark:bg-zinc-800/80";
/** 全局弹窗中的默认外壳。 */
const PLAIN_SHELL_CLASS = "flex flex-col gap-4";

interface NoteFieldProps {
  value: string;
  onChange: (v: string) => void;
}

/** 补充说明输入区（全局弹窗面板与场景卡片面板共用）。 */
function NoteField({ value, onChange }: NoteFieldProps) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
        补充说明（可选）
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder="想给 AI 更具体的指示，可写在这里…"
        className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[13px] text-zinc-900 outline-none transition-colors focus:border-seal dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
      />
    </div>
  );
}

interface ConfirmPanelProps {
  confirm: AuthorConfirm;
  onSettled: (id: string) => void;
  /** 内嵌在生成过程弹窗中：更紧凑的卡片式外壳 */
  embedded?: boolean;
}

/** 作者确认面板：问题 + 候选选项（单选）+ 自定义输入 + 补充说明 + 操作按钮。
 * 章节规划为「逐维度流式咨询」：每次确认只展示一个维度的 3 个选项（+ 1 个自定义输入），
 * 选定后后端带着前面的选择再生成下一个维度——一次只面对一个问题。 */
export function ConfirmPanel({ confirm, onSettled, embedded = false }: ConfirmPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false); // 已被其他入口处理（404/409）：静默收起，不弹错误
  const customRef = useRef<HTMLInputElement | null>(null);
  /** 章节功能 label 映射（枚举字典，后端单一源；拉取前显示原始 value）。 */
  const [fnLabels, setFnLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    void loadFunctionLabels().then(setFnLabels);
  }, []);

  // 每条确认打开时重置表单（放在条件返回之前，保证 hooks 调用顺序稳定）
  useEffect(() => {
    setSelected(null);
    setCustom("");
    setNote("");
    setBusy(false);
    setGone(false);
  }, [confirm.id]);

  // 场景卡片确认（场景规划）：一张卡 = 一个场景的五字段，逐字段单选/自定义
  if ((confirm.fields?.length ?? 0) > 0) {
    return <SceneCardPanel confirm={confirm} onSettled={onSettled} embedded={embedded} />;
  }

  // 已被其他入口处理掉（如刷新恢复时后端已 answered）
  if (gone) return null;

  // 选中 AI 建议选项时以该选项为答复；未选中任何选项但输入了自定义内容，同样以输入内容为准
  const answer = selected ?? (custom.trim() || "");
  const canSubmit = !busy && answer.length > 0;

  /** 提交答复（AI 建议选项或自定义输入）；404/409 = 后端已处理，静默收起不报错。 */
  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await submitAuthorConfirm(confirm.id, answer, note.trim() || undefined);
      onSettled(confirm.id);
    } catch {
      // 404/409 = 后端已处理（可能另一处已答复/超时跳过）：关弹窗刷新即可，不报错
      setGone(true);
      onSettled(confirm.id);
    } finally {
      setBusy(false);
    }
  }

  /** 跳过此确认：通知后端解除阻塞，生成流程继续。 */
  async function skip() {
    setBusy(true);
    try {
      await dismissAuthorConfirm(confirm.id);
    } catch {
      // 已处理/不存在：同样视为已跳过
    } finally {
      setBusy(false);
      onSettled(confirm.id);
    }
  }

  /** 场景写法提案「都不满意，重新生成」：后端重新生成 5 个提案后以新确认点再弹。 */
  async function regenerate() {
    setBusy(true);
    try {
      await submitAuthorConfirm(confirm.id, "__regenerate__");
    } catch {
      setGone(true);
    } finally {
      setBusy(false);
      onSettled(confirm.id);
    }
  }

  return (
    <div className={embedded ? EMBEDDED_SHELL_CLASS : PLAIN_SHELL_CLASS}>
      <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">{confirm.question}</p>

      {confirm.options.length > 0 && (
        <div className="space-y-2" role="radiogroup" aria-label="候选方向">
          {confirm.options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={selected === opt.id}
              onClick={() => {
                setSelected(opt.id);
                setCustom("");
              }}
              className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selected === opt.id
                  ? "border-seal bg-seal/5"
                  : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/60"
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  selected === opt.id ? "border-seal" : "border-zinc-300 dark:border-zinc-600"
                }`}
              >
                {selected === opt.id && <span aria-hidden className="h-2 w-2 rounded-full bg-seal" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
                  {opt.label ?? opt.text}
                </span>
                {opt.desc ? (
                  <span className="mt-0.5 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                    {opt.desc}
                  </span>
                ) : null}
                {opt.core_conflict || opt.protagonist_arc ? (
                  <span className="mt-1 block space-y-0.5">
                    {opt.core_conflict ? (
                      <span className="block text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                        <span className="font-medium text-zinc-500">核心冲突：</span>
                        {opt.core_conflict}
                      </span>
                    ) : null}
                    {opt.protagonist_arc ? (
                      <span className="block text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                        <span className="font-medium text-zinc-500">主角会怎么反应：</span>
                        {opt.protagonist_arc}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {(opt.title || (opt.beats?.length ?? 0) > 0) ? (
                  <span className="mt-2 block space-y-1.5 rounded-md border border-zinc-200 bg-white/70 p-2.5 text-xs leading-5 dark:border-zinc-700 dark:bg-zinc-900/40">
                    {opt.title ? (
                      <span className="block">
                        <span className="font-medium text-zinc-500">标题：</span>
                        {opt.title}
                      </span>
                    ) : null}
                    {opt.goal ? (
                      <span className="block">
                        <span className="font-medium text-zinc-500">目标：</span>
                        {opt.goal}
                      </span>
                    ) : null}
                    {opt.chapter_function || opt.pov ? (
                      <span className="block">
                        {opt.chapter_function ? (
                          <span className="mr-3">
                            <span className="font-medium text-zinc-500">节奏：</span>
                            {fnLabels[opt.chapter_function] ?? opt.chapter_function}
                          </span>
                        ) : null}
                        {opt.pov ? (
                          <span>
                            <span className="font-medium text-zinc-500">视角：</span>
                            {opt.pov}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    {(opt.beats?.length ?? 0) > 0 ? (
                      <span className="block">
                        <span className="font-medium text-zinc-500">节拍：</span>
                        <span className="mt-0.5 block pl-4 text-zinc-600 dark:text-zinc-300">
                          {opt.beats!.map((b, i) => (
                            <span key={i} className="block">
                              {i + 1}. {b}
                            </span>
                          ))}
                        </span>
                      </span>
                    ) : null}
                    {opt.ending_hook ? (
                      <span className="block">
                        <span className="font-medium text-zinc-500">结尾钩子：</span>
                        {opt.ending_hook}
                      </span>
                    ) : null}
                    {opt.entry || opt.tone || opt.satisfaction ? (
                      <span className="mt-1 block border-t border-zinc-200 pt-1.5 dark:border-zinc-700">
                        <span className="font-medium text-zinc-500">写法要点：</span>
                        <span className="mt-0.5 block pl-4 text-zinc-600 dark:text-zinc-300">
                          {opt.entry ? (
                            <span className="block">
                              进入/触发：{opt.entry}
                            </span>
                          ) : null}
                          {opt.tone ? (
                            <span className="block">
                              风格基调：{opt.tone}
                            </span>
                          ) : null}
                          {opt.satisfaction ? (
                            <span className="block">
                              爽点类型：{opt.satisfaction}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}

      {confirm.allow_custom && (
        <div
          className={`flex w-full items-start gap-3 rounded-lg border p-3 transition-colors ${
            custom.trim()
              ? "border-seal bg-seal/5"
              : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/60"
          }`}
        >
          <span
            aria-hidden
            className={`mt-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
              custom.trim() ? "border-seal" : "border-zinc-300 dark:border-zinc-600"
            }`}
          >
            {custom.trim() && <span aria-hidden className="h-2 w-2 rounded-full bg-seal" />}
          </span>
          <input
            ref={customRef}
            type="text"
            value={custom}
            onChange={(e) => {
              const v = e.target.value;
              setCustom(v);
              // 输入自定义内容时：若已选中某个 AI 建议则取消选中，提交以输入内容为准
              if (selected) setSelected(null);
            }}
            placeholder="输入你的想法…"
            className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-seal dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </div>
      )}

      <NoteField value={note} onChange={setNote} />

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        {confirm.regenerable && (
          <button
            type="button"
            onClick={regenerate}
            disabled={busy}
            className="mr-auto rounded-md px-3 py-1.5 text-[13px] text-seal transition-colors hover:bg-seal/10 disabled:opacity-50"
          >
            都不满意，重新生成
          </button>
        )}
        <button
          type="button"
          onClick={skip}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          跳过，由 AI 自行把握
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-md bg-seal px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "提交中…" : "确认此方向"}
        </button>
      </div>
    </div>
  );
}

/** 场景卡片确认面板（场景规划）：一张卡 = 一个场景的五字段（地点/出场人物/目标/冲突/结果）。
 * 每个字段 5 个候选单选 + 1 个自定义输入，全部字段填完后提交；
 * 后端把每字段选定的文本拼进「场景执行清单」，注入小说家作为硬约束。 */
function SceneCardPanel({ confirm, onSettled, embedded = false }: ConfirmPanelProps) {
  const fields = confirm.fields ?? [];
  const [fieldSel, setFieldSel] = useState<Record<string, string>>({});
  const [fieldCustom, setFieldCustom] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  // 每条确认打开时重置表单
  useEffect(() => {
    setFieldSel({});
    setFieldCustom({});
    setNote("");
    setBusy(false);
    setGone(false);
  }, [confirm.id]);

  if (gone) return null;

  // 字段最终取值：选中候选取选项 text；未选中但填了自定义则取自定义文本
  function fieldValue(f: AuthorConfirmField): string {
    const selId = fieldSel[f.field];
    if (selId) {
      const opt = f.options.find((o) => o.id === selId);
      if (opt) return opt.text ?? opt.label ?? "";
    }
    return (fieldCustom[f.field] ?? "").trim();
  }

  const allFilled = fields.length > 0 && fields.every((f) => fieldValue(f).length > 0);

  /** 提交所有字段的选定/自定义内容（__fields__ 协议，后端拼进场景执行清单）。 */
  async function submit() {
    if (!allFilled || busy) return;
    setBusy(true);
    const answers: Record<string, string> = {};
    for (const f of fields) answers[f.field] = fieldValue(f);
    try {
      await submitAuthorConfirm(confirm.id, "__fields__", note.trim() || undefined, answers);
      onSettled(confirm.id);
    } catch {
      setGone(true);
      onSettled(confirm.id);
    } finally {
      setBusy(false);
    }
  }

  /** 跳过此确认：通知后端解除阻塞，生成流程继续。 */
  async function skip() {
    setBusy(true);
    try {
      await dismissAuthorConfirm(confirm.id);
    } catch {
      // 已处理/不存在：同样视为已跳过
    } finally {
      setBusy(false);
      onSettled(confirm.id);
    }
  }

  return (
    <div className={embedded ? EMBEDDED_SHELL_CLASS : PLAIN_SHELL_CLASS}>
      <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">{confirm.question}</p>

      <div className="space-y-4">
        {fields.map((f, fi) => {
          const selectedId = fieldSel[f.field] ?? null;
          const custom = fieldCustom[f.field] ?? "";
          return (
            <div key={f.field} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                  {fi + 1}. {f.label}
                </span>
                {f.hint ? (
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{f.hint}</span>
                ) : null}
              </div>
              <div className="space-y-1.5">
                {f.options.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={selectedId === opt.id}
                    onClick={() => {
                      setFieldSel((s) => ({ ...s, [f.field]: opt.id }));
                      setFieldCustom((s) => ({ ...s, [f.field]: "" }));
                    }}
                    className={`flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
                      selectedId === opt.id
                        ? "border-seal bg-seal/5"
                        : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/60"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                        selectedId === opt.id ? "border-seal" : "border-zinc-300 dark:border-zinc-600"
                      }`}
                    >
                      {selectedId === opt.id && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-seal" />}
                    </span>
                    <span className="text-[13px] leading-5 text-zinc-800 dark:text-zinc-200">
                      {opt.text ?? opt.label}
                    </span>
                  </button>
                ))}
                <div
                  className={`mt-1.5 flex items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
                    custom.trim() ? "border-seal bg-seal/5" : "border-zinc-200 dark:border-zinc-700"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                      custom.trim() ? "border-seal" : "border-zinc-300 dark:border-zinc-600"
                    }`}
                  >
                    {custom.trim() && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-seal" />}
                  </span>
                  <input
                    type="text"
                    value={custom}
                    onChange={(e) => {
                      const v = e.target.value;
                      setFieldCustom((s) => ({ ...s, [f.field]: v }));
                      if (v.trim() && selectedId) {
                        setFieldSel((s) => ({ ...s, [f.field]: "" }));
                      }
                    }}
                    placeholder={`自定义「${f.label}」…`}
                    className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-seal dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <NoteField value={note} onChange={setNote} />

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <button
          type="button"
          onClick={skip}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          跳过，由 AI 自行把握
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!allFilled || busy}
          className="rounded-md bg-seal px-4 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "提交中…" : "确认此场景"}
        </button>
      </div>
    </div>
  );
}
