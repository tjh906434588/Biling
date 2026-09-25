"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { listNovels, createNovel, updateNovel, deleteNovel, type Novel } from "@/lib/api";
import Brand from "@/components/brand";
import NovelCover from "@/components/novel-cover";
import { ONBOARDING_STEPS } from "@/components/onboarding";
import { message } from "@/components/message";
import { BACKGROUND_TYPES, BackgroundTypePicker, GenrePicker } from "@/components/novel-meta";

const GUIDE_KEY = "biling.guide.hidden";

function formatDate(iso?: string): string {
  if (!iso) return "刚刚";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "刚刚";
  const diff = Date.now() - d.getTime();
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < HOUR) return "刚刚";
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ── 新建小说弹窗：工具类应用的轻对话框，而不是页面里的一块表单 ── */
function CreateDialog({
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
              <span className="ml-2 font-normal text-zinc-400">不确定可不选，导入蓝图时 AI 引导确认</span>
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
            <span className="text-[11.5px] text-zinc-400">只在本机保存，正文不上传</span>
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
function EditDialog({
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
              <span className="ml-2 font-normal text-zinc-400">不确定可不选，导入蓝图时 AI 引导确认</span>
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
function DeleteDialog({
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
          该小说的全部章节、正文、设定、蓝图、伏笔账本、记忆层与评价都会一并删除，且无法恢复。
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

export default function Home() {
  const [novels, setNovels] = useState<Novel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  /** 编辑弹窗的目标小说；null=未打开。 */
  const [editTarget, setEditTarget] = useState<Novel | null>(null);
  /** 删除确认弹窗的目标小说；null=未打开。 */
  const [deleteTarget, setDeleteTarget] = useState<Novel | null>(null);
  /** 进行中的删除/编辑操作：非 null 时盖全屏 Loading 遮罩，操作完成并重新拉取数据后才解锁。 */
  const [operating, setOperating] = useState<null | { kind: "edit" | "delete"; title: string }>(null);
  const [guideHidden, setGuideHidden] = useState(true);
  const autoOpened = useRef(false);

  async function refresh() {
    try {
      const list = await listNovels();
      setNovels(list);
      // 空书架 + 第一次来：直接铺开欢迎面板（含新建表单），少一次点击
      if (!autoOpened.current) {
        autoOpened.current = true;
        if (list.length === 0) setGuideHidden(false);
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /** 保存编辑：盖全屏 Loading，成功后重新拉取列表再解锁（遮罩期间拦截一切点击，防重复提交）。 */
  async function handleSaveEdit(
    n: Novel,
    data: { title: string; premise?: string; background_type?: Novel["background_type"]; genres?: string[] },
  ) {
    if (operating) return;
    setOperating({ kind: "edit", title: n.title });
    try {
      await updateNovel(n.id, data);
      await refresh();
      setEditTarget(null);
      message.success("已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setOperating(null);
    }
  }

  /** 删除小说：先弹二次确认，确认后盖全屏 Loading，成功后重新拉取列表再解锁。 */
  async function handleDelete(n: Novel) {
    if (operating) return;
    setOperating({ kind: "delete", title: n.title });
    try {
      await deleteNovel(n.id);
      await refresh();
      setDeleteTarget(null);
      message.success("已删除");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setOperating(null);
    }
  }

  useEffect(() => {
    void refresh();
    try {
      setGuideHidden(localStorage.getItem(GUIDE_KEY) === "1");
    } catch {
      /* 隐私模式下 localStorage 不可用，忽略即可 */
    }
  }, []);

  function hideGuide() {
    setGuideHidden(true);
    try {
      localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      /* 同上 */
    }
  }

  const isEmpty = !loading && novels.length === 0;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* ── 应用顶栏：紧凑工具栏，不是营销导航 ──────────────────── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-paper/90 px-3 backdrop-blur-md sm:px-4">
        <Brand size="sm" showLatin={false} />
        <span aria-hidden className="h-4 w-px bg-zinc-300" />
        <p className="hidden text-[12px] text-zinc-500 sm:block">AI 小说工作台</p>
      </header>

      {/* ── 主画布：内部滚动，整页不滚 ──────────────────────────── */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
          {loading ? (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <li key={i}>
                  <div className="aspect-[3/4] w-full animate-pulse rounded-[5px] bg-zinc-100" />
                  <div className="mt-3 h-3.5 w-2/3 animate-pulse rounded bg-zinc-100" />
                </li>
              ))}
            </ul>
          ) : isEmpty ? (
            /* ── 空书架：欢迎 + 四步指引 + 开工表单，一屏收完 ────────── */
            <div className="rise mx-auto mt-4 grid max-w-[880px] gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:gap-10">
              <div>
                <h1 className="font-serif text-[clamp(1.5rem,3vw,2rem)] font-medium leading-snug text-zinc-900">
                  从一句脑洞，
                  <br />
                  到一部写完的小说
                </h1>
                <p className="mt-4 text-[13.5px] leading-7 text-zinc-500">
                  六个 AI 角色分工协作，共用一份记忆层。按下面四步走完，第一本书的闭环就转起来了。
                </p>
                <ol className="mt-7 flex flex-col gap-3.5">
                  {ONBOARDING_STEPS.map((s, i) => (
                    <li key={s.key} className="flex items-start gap-3">
                      <span className="seal mt-0.5 h-5.5 w-5.5 shrink-0 text-[11px]">{i + 1}</span>
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-medium text-zinc-800">{s.title}</p>
                        <p className="mt-0.5 text-[12px] leading-5 text-zinc-500">{s.desc}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              {/* 开工表单：空状态下直接给，不用点「新建」 */}
              <div className="card p-5 sm:p-6">
                <h2 className="font-serif text-[15px] font-medium text-zinc-900">开一本新书</h2>
                <EmptyCreate onCreated={(n) => (window.location.href = `/workspace/${n.id}`)} />
                <button
                  type="button"
                  className="mt-4 text-[12px] text-zinc-400 transition-colors hover:text-zinc-600"
                  onClick={hideGuide}
                >
                  下次不再显示指引
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* ── 全部作品：项目卡片网格 + 虚线新建卡 ──────────────── */}
              <div className="mb-4 flex items-baseline gap-2.5">
                <h2 className="font-serif text-[15px] font-medium text-zinc-900">全部作品</h2>
                <span className="font-mono text-[11.5px] text-zinc-400">{novels.length}</span>
              </div>

              <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {novels.map((n, i) => (
                  <li key={n.id} className="rise" style={{ "--rise-delay": `${Math.min(i, 8) * 50}ms` } as CSSProperties}>
                    <Link href={`/workspace/${n.id}`} className="group block">
                      <div className="relative rounded-[5px] ring-zinc-300/0 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-book group-hover:ring-1 group-hover:ring-zinc-300">
                        <NovelCover title={n.title} seed={i} className="aspect-[3/4] w-full" />
                        {/* 悬停操作：编辑 / 删除。卡片整体是 Link，按钮需拦掉冒泡避免触发进入工作台 */}
                        <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1.5 bg-gradient-to-t from-black/55 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                          <button
                            type="button"
                            title="编辑书名或简介"
                            aria-label="编辑"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (operating) return;
                              setEditTarget(n);
                            }}
                            className="grid h-7 w-7 place-items-center rounded-md bg-white/90 text-zinc-700 shadow-sm transition-colors hover:bg-white hover:text-seal"
                          >
                            <svg aria-hidden className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            title="删除这本小说"
                            aria-label="删除"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (operating) return;
                              setDeleteTarget(n);
                            }}
                            className="grid h-7 w-7 place-items-center rounded-md bg-white/90 text-zinc-700 shadow-sm transition-colors hover:bg-red-600 hover:text-white"
                          >
                            <svg aria-hidden className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                              <path d="M10 11v6M14 11v6" />
                            </svg>
                          </button>
                        </div>
                      </div>
                      <h3 className="mt-3 truncate text-[13.5px] font-medium text-zinc-900 transition-colors group-hover:text-seal">
                        {n.title}
                      </h3>
                      <p className="mt-1 line-clamp-1 text-[12px] text-zinc-500">
                        {n.premise || "还没有写简介"}
                      </p>
                      {n.genres && n.genres.length > 0 ? (
                        <p className="mt-1.5 flex flex-wrap items-center gap-1">
                          {n.genres.slice(0, 3).map((g) => (
                            <span key={g} className="rounded bg-seal/10 px-1.5 py-px text-[10px] font-medium text-seal">
                              {g}
                            </span>
                          ))}
                          {n.genres.length > 3 ? (
                            <span className="font-mono text-[10px] text-zinc-400">+{n.genres.length - 3}</span>
                          ) : null}
                        </p>
                      ) : null}
                      <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[10.5px] text-zinc-400">
                        {n.background_type ? (
                          <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            {BACKGROUND_TYPES.find((t) => t.value === n.background_type)?.label}
                          </span>
                        ) : (
                          <span className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-medium text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
                            未选择
                          </span>
                        )}
                        {formatDate(n.updated_at ?? n.created_at)}
                      </p>
                    </Link>
                  </li>
                ))}

                {/* 虚线新建卡：跟作品并排，位置就是手边 */}
                <li>
                  <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    className="group grid aspect-[3/4] w-full place-items-center rounded-[5px] border border-dashed border-zinc-300 transition-colors hover:border-zinc-500"
                  >
                    <span className="flex flex-col items-center gap-2.5 text-zinc-400 transition-colors group-hover:text-zinc-600">
                      <span className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-current">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      </span>
                      <span className="text-[12.5px]">新建小说</span>
                    </span>
                  </button>
                </li>
              </ul>
            </>
          )}
        </div>
      </main>

      {showCreate && (
        <CreateDialog
          onClose={() => setShowCreate(false)}
          onCreated={(n) => (window.location.href = `/workspace/${n.id}`)}
        />
      )}

      {/* ── 删除/编辑进行中：全屏 Loading 遮罩，操作完成并重新拉取数据后才解锁 ── */}
      {operating && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-[120] grid place-items-center bg-white/60 backdrop-blur-[2px] dark:bg-zinc-900/65"
        >
          <div className="flex flex-col items-center gap-2.5">
            <svg aria-hidden viewBox="0 0 24 24" fill="none" className="h-7 w-7 animate-spin text-seal">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {operating.kind === "delete"
                ? `正在删除《${operating.title}》…`
                : `正在保存《${operating.title}》…`}
            </span>
          </div>
        </div>
      )}

      {editTarget && (
        <EditDialog
          novel={editTarget}
          busy={operating != null}
          onClose={() => setEditTarget(null)}
          onSaved={(data) => void handleSaveEdit(editTarget, data)}
        />
      )}

      {deleteTarget && (
        <DeleteDialog
          novel={deleteTarget}
          busy={operating != null}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete(deleteTarget)}
        />
      )}
    </div>
  );
}

/* 空状态里的内联新建表单（与弹窗同逻辑，少一层弹窗） */
function EmptyCreate({ onCreated }: { onCreated: (n: Novel) => void }) {
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
          <span className="ml-2 font-normal text-zinc-400">不确定可不选，导入蓝图时 AI 引导确认</span>
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
