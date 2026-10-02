/**
 * @file features/bookshelf/index.tsx
 * 书架页入口（原 app/page.tsx 的页面逻辑按 feature 归位；app/page.tsx 仅做转发）。
 * 核心机制：三种渲染态——加载骨架屏 / 空书架欢迎指引 + 内联新建表单 / 作品网格；
 * 新建/编辑/删除均走「全屏 Loading 遮罩（operating）+ 操作完成后重新拉取列表再解锁」防止重复提交；
 * 空书架且首次进入时自动展开欢迎面板（localStorage 键 GUIDE_KEY 记录是否已关闭）。
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { listNovels, updateNovel, deleteNovel, exportNovel, importNovel, type Novel } from "@/lib/api";
import NovelCover from "./components/novel-cover";
import { message } from "@/components/message";
import { CreateDialog, DeleteDialog, EditDialog } from "./components/dialogs";
import { EmptyCreate } from "./components/empty-create";
import { Topbar } from "./components/topbar";
import { BACKGROUND_TYPES, GUIDE_KEY, ONBOARDING_STEPS } from "@/constants";
import { formatDate } from "@/utils/format";

/** 书架页组件：作品网格 + 新建/编辑/删除弹窗 + 空书架欢迎指引 */
export default function Bookshelf() {
  const router = useRouter();
  const [novels, setNovels] = useState<Novel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  /** 编辑弹窗的目标小说；null=未打开。 */
  const [editTarget, setEditTarget] = useState<Novel | null>(null);
  /** 删除确认弹窗的目标小说；null=未打开。 */
  const [deleteTarget, setDeleteTarget] = useState<Novel | null>(null);
  /** 进行中的操作：非 null 时盖全屏 Loading 遮罩，操作完成并重新拉取数据后才解锁。 */
  const [operating, setOperating] = useState<null | { kind: "edit" | "delete" | "import" | "export"; title: string }>(null);
  // 空书架欢迎指引是否隐藏；state 值本身未使用，只通过 setter 切换渲染分支
  const [, setGuideHidden] = useState(true);
  /** 是否已做过「空书架自动展开欢迎面板」（仅首次且书架为空时执行一次） */
  const autoOpened = useRef(false);

  /** 拉取小说列表；若书架为空且首次进入，自动展开欢迎面板（少一次点击） */
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

  /** 导出整本书：后端打包为 zip，触发浏览器下载。 */
  async function handleExport(n: Novel) {
    if (operating) return;
    setOperating({ kind: "export", title: n.title });
    try {
      const { blob, filename } = await exportNovel(n.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      message.success("已导出备份");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setOperating(null);
    }
  }

  /** 导入整本书：后端还原为一本内容完全相同的新书，成功后刷新列表并直接进入续写。 */
  async function handleImport(file: File) {
    if (operating) return;
    setOperating({ kind: "import", title: file.name });
    try {
      const novel = await importNovel(file);
      await refresh();
      message.success(`已导入：${novel.title}，可无缝续写`);
      router.push(`/workspace/${novel.id}`);
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

  /** 关闭空书架指引并写入 localStorage，之后不再展示 */
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Topbar onImport={handleImport} busy={!!operating} />

      {/* ── 主画布：内部滚动，整页不滚 ──────────────────────────── */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
          {loading ? (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
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
                  几个 AI 助手分工合作，共用一份『故事记忆』。按下面四步走完，第一本就通了。
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
                <EmptyCreate onCreated={(n) => router.push(`/workspace/${n.id}`)} />
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

              <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                {novels.map((n, i) => (
                  <li key={n.id} className="rise" style={{ "--rise-delay": `${Math.min(i, 8) * 50}ms` } as CSSProperties}>
                    <Link href={`/workspace/${n.id}`} className="group block">
                      <div className="relative rounded-[5px] ring-zinc-300/0 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-book group-hover:ring-1 group-hover:ring-zinc-300">
                        <NovelCover title={n.title} seed={i} className="aspect-[3/4] w-full" />
                        {/* 悬停操作：导出 / 编辑 / 删除。卡片整体是 Link，按钮需拦掉冒泡避免触发进入工作台 */}
                        <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1.5 bg-gradient-to-t from-black/55 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                          <button
                            type="button"
                            title="导出整本书备份（换电脑 / 备份用）"
                            aria-label="导出"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void handleExport(n);
                            }}
                            className="grid h-7 w-7 place-items-center rounded-md bg-white/90 text-zinc-700 shadow-sm transition-colors hover:bg-white hover:text-seal"
                          >
                            <svg aria-hidden className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                            </svg>
                          </button>
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
          onCreated={(n) => router.push(`/workspace/${n.id}`)}
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
