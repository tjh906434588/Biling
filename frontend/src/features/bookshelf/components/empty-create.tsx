"use client";

/**
 * @file empty-create.tsx
 * 空书架欢迎面板内的内联新建表单：与新建弹窗同逻辑，省去弹窗层级。
 * 直接调用 createNovel，成功后通过 onCreated 回调由页面跳转工作台。
 */
import { useState } from "react";
import { createNovel, type Novel } from "@/lib/api";
import { message } from "@/components/message";
import { BackgroundTypePicker, GenrePicker } from "@/components/novel-meta";

/* 空状态里的内联新建表单（与弹窗同逻辑，少一层弹窗） */
/**
 * 空书架欢迎面板内的内联新建表单：逻辑与 CreateDialog 相同，省去弹窗层级。
 * @param onCreated 创建成功回调（跳转工作台）
 */
export function EmptyCreate({ onCreated }: { onCreated: (n: Novel) => void }) {
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
      onCreated(
        await createNovel({
          title: title.trim(),
          premise: premise.trim() || undefined,
          background_type: backgroundType ?? undefined,
          genres: genres.length ? genres : undefined,
        }),
      );
    } catch (e) {
      message.error((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <form
      className="mt-4 flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void handleCreate();
      }}
    >
      <input
        autoFocus
        className="w-full rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 font-serif text-[16px] text-zinc-900 outline-none transition-colors placeholder:font-sans placeholder:text-[13px] placeholder:text-zinc-400 focus:border-zinc-500"
        placeholder="书名，例如：雨夜铜币"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        rows={3}
        maxLength={500}
        className="w-full resize-none rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 text-[13px] leading-5 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500"
        placeholder="一句话简介（可选）"
        value={premise}
        onChange={(e) => setPremise(e.target.value)}
      />
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
      <button type="submit" className="btn btn-primary w-full" disabled={creating || !title.trim()}>
        {creating ? "正在建…" : "创建并进入工作台"}
      </button>
    </form>
  );
}
