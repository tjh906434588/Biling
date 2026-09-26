"use client";

/** 生成流程内的作者确认机制：模块级 store + 全局弹窗宿主。
 *
 * 后端生成任务在"需要作者定夺"的确认点暂停（方向提案 / 时代研究结论），通过 SSE
 * author_confirm 事件实时通知前端弹窗；刷新 / 断线后靠 GET /confirm 轮询恢复。
 *
 * 为什么是模块级 store：确认点可能在任何 tab 的生成流程中触发（蓝图页的时代研究、
 * 大纲页的方向提案），组件随 tab 切换卸载，本地 state 会丢。提升到模块级后：
 * - 弹窗跨 tab 常驻，作者切页也不会漏掉确认；
 * - 刷新后重新进入工作台时从后端恢复未答复的确认并再次弹窗。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import Modal from "./modal";
import { notification, removeNotification } from "./notification";
import {
  dismissAuthorConfirm,
  fetchPendingConfirms,
  submitAuthorConfirm,
  type AuthorConfirm,
  type AuthorConfirmField,
} from "@/lib/api";

/** 角色名 → 展示名（确认弹窗标题用）。 */
const AGENT_LABELS: Record<string, string> = {
  outliner: "大纲师",
  era_researcher: "时代·行业研究员",
  blueprint_architect: "蓝图师",
  blueprint_prechecker: "蓝图质检师",
  chapter_planner: "章节规划师",
  scene_planner: "场景规划师",
  novelist: "小说家",
};

/** 节奏功能英文 → 中文（规划详情展示用）。 */
const FUNCTION_LABELS: Record<string, string> = {
  progression: "推进",
  buildup: "蓄势",
  turning: "转折",
  climax: "高潮",
  revelation: "揭示",
  resolution: "收束",
  interlude: "间奏",
};

type ConfirmEntry = AuthorConfirm;

const listeners = new Set<() => void>();
let queue: ConfirmEntry[] = [];

/** 已随「生成过程弹窗」内嵌展示过的确认 id：这些确认不再作为独立全局弹窗弹出。
 * 同一确认只打扰作者一次——生成弹窗关闭后（流结束/超时/作者关弹窗）它若仍未答复，
 * 按「作者忽略」处理，后端确认点超时自动 dismissed，下次恢复/切换小说时从队列清掉。 */
const inlineShownIds = new Set<string>();

/** SSR 服务端快照：恒为空，且必须引用稳定（否则 "getServerSnapshot should be cached" 无限循环警告） */
const EMPTY_CONFIRM_SNAPSHOT: ConfirmEntry[] = [];
const EMPTY_INLINE_SNAPSHOT: ReadonlyMap<string, number> = new Map();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeAuthorConfirms(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAuthorConfirms(): ConfirmEntry[] {
  return queue;
}

function upsert(confirm: AuthorConfirm) {
  const i = queue.findIndex((c) => c.id === confirm.id);
  if (i >= 0) {
    // 已存在：合并新字段并生成新数组（保证引用变化，useSyncExternalStore 才能触发重渲染）
    queue = queue.map((c, idx) => (idx === i ? { ...c, ...confirm } : c));
  } else {
    queue = [...queue, confirm];
  }
  emit();
}

/** SSE author_confirm 事件推入（生成流程实时弹窗）。
 * 推入时若该小说已有生成弹窗在运行（内嵌宿主活跃），确认将随弹窗内嵌展示，
 * 打上「已内嵌展示」标记，全局弹窗宿主随后跳过它——避免同一确认内嵌+独立弹窗重复弹。 */
export function pushAuthorConfirm(confirm: AuthorConfirm) {
  if ((inlineHostCount.get(confirm.novel_id) ?? 0) > 0) {
    inlineShownIds.add(confirm.id);
  }
  upsert(confirm);
}

function removeConfirm(id: string) {
  queue = queue.filter((c) => c.id !== id);
  inlineShownIds.delete(id);
  emit();
}
/** 供生成过程弹窗等内嵌宿主移除已答复的确认。 */
export { removeConfirm };

/** ── 内嵌确认宿主：生成过程弹窗（AgentStreamModal）打开且正在生成时注册，全局弹窗让位 ──
 * 计数按 novelId 累加/递减：同一小说可能同时开多个生成弹窗（写作页的生成/评价/优化），
 * 只要有一个在运行，确认就应内嵌其中展示，避免再叠一层全局 Modal（层级被覆盖 / 误关其它弹窗）。 */
const inlineHostCount = new Map<string, number>();
const inlineHostListeners = new Set<() => void>();
/** 缓存快照：每次变化替换为新 Map（引用变化，useSyncExternalStore 才能触发重渲染） */
let inlineHostSnapshot: ReadonlyMap<string, number> = inlineHostCount;
function emitInlineHost() {
  inlineHostListeners.forEach((l) => l());
}
export function subscribeInlineHosts(listener: () => void): () => void {
  inlineHostListeners.add(listener);
  return () => {
    inlineHostListeners.delete(listener);
  };
}
export function getInlineHostCount(): ReadonlyMap<string, number> {
  return inlineHostSnapshot;
}
/** 生成弹窗打开且运行中：+1；关闭/停止/卸载：-1。计数归零自动移除。 */
export function setInlineHost(novelId: string, active: boolean) {
  const cur = inlineHostCount.get(novelId) ?? 0;
  const next = active ? cur + 1 : Math.max(0, cur - 1);
  if (next === 0) inlineHostCount.delete(novelId);
  else inlineHostCount.set(novelId, next);
  inlineHostSnapshot = new Map(inlineHostCount);
  emitInlineHost();
}

/** 刷新 / 切换小说后从后端恢复待确认项（去重合并；切走的小说残留项清掉）。 */
export async function restoreAuthorConfirms(novelId: string): Promise<void> {
  try {
    const items = await fetchPendingConfirms(novelId);
    const ids = new Set(items.map((i) => i.id));
    queue = queue.filter((c) => c.novel_id !== novelId || ids.has(c.id));
    for (const it of items) {
      // 重新恢复 = 新上下文（进入/切回时通常没有生成弹窗打开）：清掉「已内嵌展示」标记，
      // 允许全局弹窗宿主或内嵌宿主重新向作者展示
      inlineShownIds.delete(it.id);
      upsert(it);
    }
    emit();
  } catch {
    // 查询失败静默（后端未就绪 / 网络抖动），下次进入再试
  }
}

interface AuthorConfirmHostProps {
  novelId: string;
}

/** 全局作者确认弹窗宿主：挂在工作台根（AgentTaskToasts 旁），跨 tab 常驻。
 * 若当前小说已有「生成过程弹窗」在运行（内嵌宿主），确认改由弹窗内联展示，这里让位（避免层级覆盖 / 误关其它弹窗）。 */
export default function AuthorConfirmHost({ novelId }: AuthorConfirmHostProps) {
  // 第三个参数 = 服务端快照：SSR 预渲染时队列恒为空，避免 "Missing getServerSnapshot" 报错
  const queue = useSyncExternalStore(subscribeAuthorConfirms, getAuthorConfirms, () => EMPTY_CONFIRM_SNAPSHOT);
  const inlineCount = useSyncExternalStore(subscribeInlineHosts, getInlineHostCount, () => EMPTY_INLINE_SNAPSHOT);

  // 首次进入 / 切换小说：从后端恢复待确认项（刷新后弹窗重现）
  useEffect(() => {
    void restoreAuthorConfirms(novelId);
  }, [novelId]);

  // 当前小说有生成过程弹窗正在运行：确认由弹窗内联展示，全局弹窗让位
  if ((inlineCount.get(novelId) ?? 0) > 0) return null;

  // 同一时间只展示最早的确认请求；已随生成弹窗内嵌展示过的跳过（不再单独弹，避免重复打扰），
  // 作者答复后出队，顺延展示下一条
  const confirm = queue.find((c) => !inlineShownIds.has(c.id)) ?? null;
  return (
    <ConfirmDialog key={confirm?.id ?? "none"} confirm={confirm ?? null} onSettled={(id) => removeConfirm(id)} />
  );
}

interface ConfirmDialogProps {
  confirm: AuthorConfirm | null;
  onSettled: (id: string) => void;
}

function ConfirmDialog({ confirm, onSettled }: ConfirmDialogProps) {
  if (!confirm) return null;
  return (
    <Modal
      open
      title={`${AGENT_LABELS[confirm.agent] ?? confirm.agent} · 作者确认`}
      subtitle="生成流程在此暂停等你定夺，确认后继续"
      onClose={() => {
        // 点关闭 = 跳过：通知后端解除确认阻塞，避免轮询每 3 秒把弹窗重新推回来
        void dismissAuthorConfirm(confirm.id).catch(() => {});
        onSettled(confirm.id);
      }}
      maxWidth="max-w-xl"
    >
      <ConfirmPanel confirm={confirm} onSettled={onSettled} />
    </Modal>
  );
}

interface ConfirmPanelProps {
  confirm: AuthorConfirm;
  onSettled: (id: string) => void;
  /** 内嵌在生成过程弹窗中：更紧凑的卡片式外壳 */
  embedded?: boolean;
}

/** 作者确认面板：问题 + 候选选项（单选）+ 自定义输入 + 补充说明 + 操作按钮。
 * 章节规划为「逐维度流式咨询」：每次确认只展示一个维度的 5 个选项（+ 1 个自定义输入），
 * 选定后后端带着前面的选择再生成下一个维度——一次只面对一个问题。
 * 既可作为全局确认弹窗的内容，也可内嵌进生成过程弹窗（embedded）随生成过程一起展示。 */
export function ConfirmPanel({ confirm, onSettled, embedded = false }: ConfirmPanelProps) {
  // 场景卡片确认（场景规划）：一张卡 = 一个场景的五字段，逐字段单选/自定义
  if ((confirm.fields?.length ?? 0) > 0) {
    return <SceneCardPanel confirm={confirm} onSettled={onSettled} embedded={embedded} />;
  }

  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const customRef = useRef<HTMLInputElement | null>(null);

  // 每条确认打开时重置表单
  useEffect(() => {
    setSelected(null);
    setCustom("");
    setNote("");
    setBusy(false);
    setGone(false);
  }, [confirm.id]);

  // 已被其他入口处理掉（如刷新恢复时后端已 answered）
  if (gone) return null;

  // 选中 AI 建议选项时以该选项为答复；未选中任何选项但输入了自定义内容，同样以输入内容为准
  const answer = selected ?? (custom.trim() || "");
  const canSubmit = !busy && answer.length > 0;

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
    <div
      className={
        embedded
          // 内嵌进生成内容模块：色系与内容统一（灰阶），仅用更深的底色/边框
          // 与模块背景区分，配合上方的琥珀色标题突出"需要手动选择"
          ? "flex shrink-0 flex-col gap-3 rounded-lg border border-zinc-300 bg-zinc-100/80 p-3.5 dark:border-zinc-600 dark:bg-zinc-800/80"
          : "flex flex-col gap-4"
      }
    >
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
                            {FUNCTION_LABELS[opt.chapter_function] ?? opt.chapter_function}
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
                    {opt.entry || opt.tone || opt.protagonist_arc || opt.core_conflict || opt.satisfaction ? (
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
                          {opt.protagonist_arc ? (
                            <span className="block">
                              主角反应弧：{opt.protagonist_arc}
                            </span>
                          ) : null}
                          {opt.core_conflict ? (
                            <span className="block">
                              核心冲突：{opt.core_conflict}
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

      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          补充说明（可选）
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="想给 AI 更具体的指示，可写在这里…"
          className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[13px] text-zinc-900 outline-none transition-colors focus:border-seal dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
        />
      </div>

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
    <div
      className={
        embedded
          ? "flex shrink-0 flex-col gap-3 rounded-lg border border-zinc-300 bg-zinc-100/80 p-3.5 dark:border-zinc-600 dark:bg-zinc-800/80"
          : "flex flex-col gap-4"
      }
    >
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

      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          补充说明（可选）
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="想给 AI 更具体的指示，可写在这里…"
          className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[13px] text-zinc-900 outline-none transition-colors focus:border-seal dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
        />
      </div>

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

/** 确认轮询间隔（ms）：太长会延误提醒，太短徒增请求。 */
const CONFIRM_POLL_INTERVAL = 3000;

/**
 * 全局作者确认提醒中心（挂载在根布局，不依赖任何小说上下文）：
 * - 跨小说轮询所有待确认请求，无论作者正在哪部小说/哪个页面；
 * - 确认属于「当前工作台小说」→ 直接推入弹窗 store（自动弹确认）；
 * - 确认属于「其他小说」→ 右上角常驻 Notification，写明《书名》+ 哪个功能需要确认，
 *   点击即跳转到对应小说工作台（进入后由上面的弹窗宿主自动弹出确认）；
 * - 状态由后端 author_confirms 表持久化：刷新 / 关闭页面重开，轮询一发现就再次提醒，不会丢；
 * - 已答复 / 跳过的确认自动收回通知与弹窗。
 */
export function ConfirmNotifier() {
  const pathname = usePathname();
  const router = useRouter();
  const [currentNovel, setCurrentNovel] = useState<string | null>(null);
  /** confirm id → 已弹出的右上角通知 id（其他小说；防止每轮重复提醒，用户手动关掉则不再弹） */
  const notifiedRef = useRef(new Map<string, number>());
  /** 记录在 store 里弹过窗的确认 id：切换小说后再回来时不需要再次推入（弹窗宿主自己会恢复） */
  const modalPushedRef = useRef(new Set<string>());

  // 从 /workspace/[id] 提取当前工作台小说
  useEffect(() => {
    const m = pathname?.match(/^\/workspace\/([^/?]+)/);
    setCurrentNovel(m?.[1] ?? null);
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      let items: AuthorConfirm[];
      try {
        items = await fetchPendingConfirms();
      } catch {
        return; // 后端未就绪/网络抖动：静默，下轮再试
      }
      if (cancelled) return;

      const pendingIds = new Set(items.map((i) => i.id));

      // 已不在待确认列表的：收回对应通知（答复/跳过/超时）
      for (const [id, nid] of Array.from(notifiedRef.current.entries())) {
        if (!pendingIds.has(id)) {
          removeNotification(nid);
          notifiedRef.current.delete(id);
        }
      }

      for (const it of items) {
        if (it.novel_id === currentNovel) {
          // 当前工作台小说：交给弹窗宿主（实时 SSE 已推、切回时这里兜底恢复）
          if (!modalPushedRef.current.has(it.id)) {
            modalPushedRef.current.add(it.id);
            pushAuthorConfirm(it);
          }
          // 若此前因在别处弹过右上角通知，切回来后收掉，改由弹窗承担
          const nid = notifiedRef.current.get(it.id);
          if (nid != null) {
            removeNotification(nid);
            notifiedRef.current.delete(it.id);
          }
        } else if (!notifiedRef.current.has(it.id)) {
          // 其他小说：右上角常驻提醒，写明书名 + 哪个功能，点击跳转确认
          const label = AGENT_LABELS[it.agent] ?? it.agent;
          const nid = notification.warning({
            title: `《${it.novel_title ?? "未命名小说"}》需要你确认`,
            message: `${label}在生成中停下等你定夺：\n${it.question}`,
            duration: 0, // 常驻，直到作者去确认或主动关闭
            onClick: () => router.push(`/workspace/${it.novel_id}`),
          });
          notifiedRef.current.set(it.id, nid);
        }
      }
    };

    void poll();
    const timer = setInterval(poll, CONFIRM_POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentNovel, router]);

  return null;
}
