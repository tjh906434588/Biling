"use client";

/**
 * @file dialogs.tsx
 * 书架弹窗组：新建小说 / 编辑小说 / 删除确认三个弹窗。
 * 三者相互独立、不依赖页面闭包，仅通过 props/回调与页面通信；新建弹窗内部直连
 * createNovel，编辑/删除仅回传结果，由页面统一盖全屏 Loading 遮罩（operating）防重复提交。
 */
import { useState } from "react";
import { createNovel, type Novel } from "@/lib/api";
import { message } from "@/components/message";
import { BackgroundTypePicker, GenrePicker } from "@/components/novel-meta";

/* ── 新建小说弹窗：工具类应用的轻对话框，而不是页面里的一块表单 ── */
/**
 * 新建小说弹窗：输入书名/简介/背景类型/题材后调用 createNovel 创建。
 * @param onClose 关闭弹窗
 * @param onCreated 创建成功回调（拿到新小说后跳转工作台）
 */
export function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (n: Novel) => void;
}) {
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  // 默认「暂不选择」：不确定可不选，导入蓝图时 AI 按素材推断、作者确认后落库
  const [backgroundType, setBackgroundType] = useState<Novel["background_type"]>(undefined);
  const [genres, setGenres] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const n = await createNovel({
        title: title.trim(),
        premise: premise.trim() || undefined,
        background_type: backgroundType ?? undefined,
        genres: genres.length ? genres : undefined,
      });
      onCreated(n);
    } catch (e) {
      message.error((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/45 p-4 backdrop-blur-[2px]"
    >
      <div
        className="card rise w-full max-w-[520px] bg-white p-6 shadow-book dark:bg-zinc-900"
        role="dialog"
        aria-modal="true"
        aria-label="新建小说"
      >
        <h2 className="font-serif text-[17px] font-medium text-zinc-900">新建小说</h2>
        <p className="mt-1.5 text-[12.5px] text-zinc-500">
          起个书名就能开工，后面每一步都还能改。
        </p>

        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              书名
            </span>
            <input
              autoFocus
              className="w-full rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 font-serif text-[16px] text-zinc-900 outline-none transition-colors placeholder:font-sans placeholder:text-[13px] placeholder:text-zinc-400 focus:border-zinc-500"
              placeholder="例如：雨夜铜币"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              一句话简介
              <span className="ml-2 font-normal text-zinc-400">可选</span>
            </span>
            <textarea
              rows={3}
              maxLength={500}
              className="w-full resize-none rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 text-[13px] leading-5 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500"
              placeholder="一个记忆被篡改的占卜师之子，捡到一枚旧王徽铜币。"
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
            />
          </label>

          <div>
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              世界背景类型
              <span className="ml-2 font-normal text-zinc-400">不选也行，之后 AI 会根据故事内容帮你选</span>
            </span>
            <BackgroundTypePicker value={backgroundType} onChange={setBackgroundType} />
          </div>

          <div>
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              题材
              <span className="ml-2 font-normal text-zinc-400">可多选，决定 AI 写作方向</span>
            </span>
            <GenrePicker value={genres} onChange={setGenres} />
          </div>

          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-zinc-400">只保存在你自己电脑上，正文不会上传</span>
            <div className="flex gap-2">
              <button type="button" className="btn btn-ghost px-3.5 py-1.5 text-[13px]" onClick={onClose}>
                取消
              </button>
              <button
                type="submit"
                className="btn btn-primary px-4 py-1.5 text-[13px]"
                disabled={creating || !title.trim()}
              >
                {creating ? "正在建…" : "创建并进入"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── 编辑小说弹窗：预填书名/一句话简介，保存走 updateNovel ── */
/**
 * 编辑小说弹窗：以目标小说初始化表单，保存后回调编辑后的字段。
 * @param novel 被编辑的小说（用于预填表单）
 * @param busy 全屏操作进行中（禁用提交，防重复）
 * @param onClose 关闭弹窗
 * @param onSaved 保存回调（携带 title / premise / background_type / genres）
 */
export function EditDialog({
  novel,
  busy,
  onClose,
  onSaved,
}: {
  novel: Novel;
  busy: boolean;
  onClose: () => void;
  onSaved: (data: {
    title: string;
    premise?: string;
    background_type?: Novel["background_type"];
    genres?: string[];
  }) => void;
}) {
  const [title, setTitle] = useState(novel.title);
  const [premise, setPremise] = useState(novel.premise ?? "");
  const [backgroundType, setBackgroundType] = useState<Novel["background_type"]>(novel.background_type ?? undefined);
  const [genres, setGenres] = useState<string[]>(novel.genres ?? []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/45 p-4 backdrop-blur-[2px]">
      <div
        className="card rise w-full max-w-[520px] bg-white p-6 shadow-book dark:bg-zinc-900"
        role="dialog"
        aria-modal="true"
        aria-label="编辑小说"
      >
        <h2 className="font-serif text-[17px] font-medium text-zinc-900">编辑小说</h2>
        <p className="mt-1.5 text-[12.5px] text-zinc-500">改书名、一句话简介、世界背景类型或题材，保存后立即生效。</p>

        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || busy) return;
            onSaved({
              title: title.trim(),
              premise: premise.trim() || undefined,
              // undefined（未选）传 null 清空后端值；选了类型则传类型
              background_type: backgroundType ?? null,
              genres,
            });
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              书名
            </span>
            <input
              autoFocus
              className="w-full rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 font-serif text-[16px] text-zinc-900 outline-none transition-colors placeholder:font-sans placeholder:text-[13px] placeholder:text-zinc-400 focus:border-zinc-500"
              placeholder="书名"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              一句话简介
              <span className="ml-2 font-normal text-zinc-400">可选</span>
            </span>
            <textarea
              rows={3}
              maxLength={500}
              className="w-full resize-none rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 text-[13px] leading-5 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500"
              placeholder="一句话简介"
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
            />
          </label>

          <div>
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              世界背景类型
              <span className="ml-2 font-normal text-zinc-400">不选也行，之后 AI 会根据故事内容帮你选</span>
            </span>
            <BackgroundTypePicker value={backgroundType} onChange={setBackgroundType} />
          </div>

          <div>
            <span className="mb-1.5 block text-[12px] font-medium tracking-wide text-zinc-500">
              题材
              <span className="ml-2 font-normal text-zinc-400">可多选，决定 AI 写作方向</span>
            </span>
            <GenrePicker value={genres} onChange={setGenres} />
          </div>

          <div className="mt-1 flex items-center justify-end gap-2">
            <button type="button" className="btn btn-ghost px-3.5 py-1.5 text-[13px]" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary px-4 py-1.5 text-[13px]"
              disabled={busy || !title.trim()}
            >
              {busy ? "正在保存…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── 删除确认弹窗：删除不可恢复，需二次确认 ── */
/**
 * 删除确认弹窗：明确告知删除范围且不可恢复，需用户二次确认。
 * @param novel 待删除的小说（展示书名）
 * @param busy 全屏操作进行中（禁用按钮）
 * @param onClose 取消删除
 * @param onConfirm 确认删除回调
 */
export function DeleteDialog({
  novel,
  busy,
  onClose,
  onConfirm,
}: {
  novel: Novel;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/45 p-4 backdrop-blur-[2px]">
      <div
        className="card rise w-full max-w-[440px] bg-white p-6 shadow-book dark:bg-zinc-900"
        role="alertdialog"
        aria-modal="true"
        aria-label="删除小说"
      >
        <h2 className="font-serif text-[17px] font-medium text-zinc-900">删除《{novel.title}》？</h2>
        <p className="mt-2 text-[12.5px] leading-6 text-zinc-500">
          这本小说的全部章节、正文、设定、蓝图、伏笔记录、AI 记忆与评价都会一并删除，且无法恢复。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-ghost px-3.5 py-1.5 text-[13px]" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="btn bg-red-600 px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-45 dark:bg-red-700 dark:hover:bg-red-600"
          >
            {busy ? "正在删除…" : "确认删除"}
          </button>
        </div>
      </div>
    </div>
  );
}
