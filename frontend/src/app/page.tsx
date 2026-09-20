"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { listNovels, createNovel, type Novel } from "@/lib/api";
import Brand from "@/components/brand";
import NovelCover from "@/components/novel-cover";
import { ONBOARDING_STEPS } from "@/components/onboarding";
import { message } from "@/components/message";

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
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const n = await createNovel({
        title: title.trim(),
        premise: premise.trim() || undefined,
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
            <input
              className="w-full rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 text-[13px] outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500"
              placeholder="一个记忆被篡改的占卜师之子，捡到一枚旧王徽铜币。"
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
            />
          </label>

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

export default function Home() {
  const [novels, setNovels] = useState<Novel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
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

  const recent = [...novels].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  )[0];
  const isEmpty = !loading && novels.length === 0;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* ── 应用顶栏：紧凑工具栏，不是营销导航 ──────────────────── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 bg-paper/90 px-3 backdrop-blur-md sm:px-4">
        <Brand size="sm" showLatin={false} />
        <span aria-hidden className="h-4 w-px bg-zinc-300" />
        <p className="hidden text-[12px] text-zinc-500 sm:block">AI 小说工作台</p>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="btn btn-primary px-3.5 py-1.5 text-[13px]"
            onClick={() => setShowCreate(true)}
          >
            <svg
              aria-hidden
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            新建小说
          </button>
        </div>
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
              {/* ── 继续写作：最近一本，一键回到现场 ─────────────────── */}
              {recent && (
                <Link
                  href={`/workspace/${recent.id}`}
                  className="card group mb-7 flex items-center gap-4 p-3.5 transition-colors hover:border-zinc-400 sm:gap-5 sm:p-4"
                >
                  <div className="w-14 shrink-0 overflow-hidden rounded-[4px] shadow-book sm:w-16">
                    <NovelCover title={recent.title} seed={0} className="aspect-[3/4] w-full" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] tracking-[0.2em] text-zinc-400">继续写作</p>
                    <h2 className="mt-1 truncate font-serif text-[16px] font-medium text-zinc-900 transition-colors group-hover:text-seal">
                      {recent.title}
                    </h2>
                    <p className="mt-1 truncate text-[12.5px] text-zinc-500">
                      {recent.premise || "还没有写简介"} · {formatDate(recent.updated_at ?? recent.created_at)}
                    </p>
                  </div>
                  <span
                    aria-hidden
                    className="mr-1 shrink-0 text-zinc-300 transition-all duration-300 group-hover:translate-x-1 group-hover:text-seal"
                  >
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </Link>
              )}

              {/* ── 全部作品：项目卡片网格 + 虚线新建卡 ──────────────── */}
              <div className="mb-4 flex items-baseline gap-2.5">
                <h2 className="font-serif text-[15px] font-medium text-zinc-900">全部作品</h2>
                <span className="font-mono text-[11.5px] text-zinc-400">{novels.length}</span>
              </div>

              <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {novels.map((n, i) => (
                  <li key={n.id} className="rise" style={{ "--rise-delay": `${Math.min(i, 8) * 50}ms` } as CSSProperties}>
                    <Link href={`/workspace/${n.id}`} className="group block">
                      <div className="rounded-[5px] ring-zinc-300/0 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-book group-hover:ring-1 group-hover:ring-zinc-300">
                        <NovelCover title={n.title} seed={i} className="aspect-[3/4] w-full" />
                      </div>
                      <h3 className="mt-3 truncate text-[13.5px] font-medium text-zinc-900 transition-colors group-hover:text-seal">
                        {n.title}
                      </h3>
                      <p className="mt-1 line-clamp-1 text-[12px] text-zinc-500">
                        {n.premise || "还没有写简介"}
                      </p>
                      <p className="mt-1.5 font-mono text-[10.5px] text-zinc-400">
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
    </div>
  );
}

/* 空状态里的内联新建表单（与弹窗同逻辑，少一层弹窗） */
function EmptyCreate({ onCreated }: { onCreated: (n: Novel) => void }) {
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      onCreated(await createNovel({ title: title.trim(), premise: premise.trim() || undefined }));
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
      <input
        className="w-full rounded-lg border border-zinc-300 bg-paper px-3.5 py-2.5 text-[13px] outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500"
        placeholder="一句话简介（可选）"
        value={premise}
        onChange={(e) => setPremise(e.target.value)}
      />
      <button type="submit" className="btn btn-primary w-full" disabled={creating || !title.trim()}>
        {creating ? "正在建…" : "创建并进入工作台"}
      </button>
    </form>
  );
}
