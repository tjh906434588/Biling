"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "./modal";
import Loading from "@/components/loading";
import { message } from "@/components/message";
import {
  listPrompts,
  resetPrompt,
  updatePrompt,
  type AgentPrompt,
  type WritingPromptField,
} from "@/lib/api";

const FIELD_META: { key: WritingPromptField; label: string; hint: string }[] = [
  { key: "mindset", label: "心态与定位", hint: "这个角色以什么身份、什么心态工作。" },
  { key: "style_rules", label: "具体要求", hint: "这个角色必须遵循的做法，每行一条。" },
  { key: "forbidden", label: "绝对禁止", hint: "这个角色绝不能做的，每行一条。" },
  { key: "check_standard", label: "检验标准", hint: "产出后用这套标准自检。" },
];

const EMPTY_FIELDS: Record<WritingPromptField, string> = {
  mindset: "",
  style_rules: "",
  forbidden: "",
  check_standard: "",
};

/** 每部小说独立的写作指令配置：工作台左下角入口，对当前小说的各创作/评审角色配置结构化 System Prompt 片段。 */
export default function PromptsModal({
  open,
  onClose,
  novelId,
}: {
  open: boolean;
  onClose: () => void;
  novelId: string;
}) {
  const [agents, setAgents] = useState<AgentPrompt[]>([]);
  const [activeKey, setActiveKey] = useState("novelist");
  const [draft, setDraft] = useState<Record<WritingPromptField, string>>({ ...EMPTY_FIELDS });
  const [saving, setSaving] = useState(false);
  // 打开弹窗时数据加载中：遮罩过渡，加载完成后解除
  const [loading, setLoading] = useState(false);
  const loadedForRef = useRef<string | null>(null);

  const active = agents.find((a) => a.key === activeKey) ?? null;

  async function load() {
    setLoading(true);
    try {
      const list = await listPrompts(novelId);
      setAgents(list);
      const first = list[0];
      if (first) {
        setActiveKey(first.key);
        setDraft({ ...first.fields });
        loadedForRef.current = first.key;
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // 打开弹窗时加载角色列表（首次加载当前生效值）
  useEffect(() => {
    if (open) {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // draft 变化（输入/切换角色/加载）后重新计算所有 textarea 高度（React 19 的 ref callback 只在挂载时调用）
  useEffect(() => {
    const t = setTimeout(() => {
      document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach(autoGrow);
    }, 0);
    return () => clearTimeout(t);
  }, [draft]);

  function switchAgent(key: string) {
    const a = agents.find((x) => x.key === key);
    if (!a) return;
    setActiveKey(key);
    setDraft({ ...a.fields });
    loadedForRef.current = key;
  }

  /** 让 textarea 高度跟随内容自适应（初始即按内容高度，输入时随之增高）。 */
  function autoGrow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  async function handleSave() {
    if (!active) return;
    setSaving(true);
    try {
      // 输入框里是什么就保存什么：默认值可改、可删（留空的字段不传给 AI）；想恢复初始值点「恢复默认」
      const updated = await updatePrompt(novelId, active.key, draft);
      setAgents((prev) => prev.map((a) => (a.key === updated.key ? updated : a)));
      setDraft({ ...updated.fields });
      message.success("已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!active) return;
    setSaving(true);
    try {
      const updated = await resetPrompt(novelId, active.key);
      setAgents((prev) => prev.map((a) => (a.key === updated.key ? updated : a)));
      setDraft({ ...updated.fields });
      message.success("已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const scopeNote = !active
    ? ""
    : active.configured
      ? "已自定义：留空的字段不传给 AI。优先级低于本小说的「风格」与「蓝图」——冲突时以风格和蓝图为准；不冲突时必须严格执行。"
      : "当前使用该角色的内置默认指令，可直接修改或删掉留空（留空的字段不传给 AI）；点「恢复默认」随时找回初始值。";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="写作指令"
      subtitle="为当前小说配置创作/评审角色的写作人设，仅本小说生效。"
      maxWidth="max-w-3xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleReset}
            disabled={saving || !active?.configured}
          >
            恢复默认
          </button>
          <div className="flex items-center gap-3">
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      }
    >
      <Loading loading={loading} inset>
        <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
        {/* 角色列表 */}
        <ul className="flex flex-col gap-1">
          {agents.map((a) => (
            <li key={a.key}>
              <button
                type="button"
                onClick={() => switchAgent(a.key)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                  a.key === activeKey
                    ? "bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-100/60 hover:text-zinc-900 dark:hover:bg-zinc-800/60"
                }`}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    a.configured ? "bg-seal" : "bg-zinc-300 dark:bg-zinc-600"
                  }`}
                  title={a.configured ? "已自定义" : "默认"}
                />
                {a.name}
              </button>
            </li>
          ))}
        </ul>

        {/* 字段编辑区 */}
        <div className="min-w-0">
          <p className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] leading-5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            {scopeNote}
          </p>
          <div className="flex flex-col gap-4">
            {FIELD_META.filter((f) => active && f.key in active.fields).map((f) => (
              <label key={f.key} className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200">{f.label}</span>
                <span className="text-[11.5px] leading-4 text-zinc-400">{f.hint}</span>
                <textarea
                  ref={autoGrow}
                  value={draft[f.key]}
                  onChange={(e) => {
                    setDraft((prev) => ({ ...prev, [f.key]: e.target.value }));
                    autoGrow(e.target);
                  }}
                  rows={2}
                  placeholder="留空则不传给 AI"
                  className="resize-none overflow-hidden rounded-md border border-zinc-300 bg-white p-2.5 text-[13px] leading-5 outline-none placeholder:text-zinc-400 focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              </label>
            ))}
          </div>
        </div>
      </div>
      </Loading>
    </Modal>
  );
}
