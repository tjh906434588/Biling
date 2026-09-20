"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

export interface OnboardingStep {
  key: string;
  title: string;
  desc: string;
  note: string;
}

/** 与产品里真实的 5 个角色一一对应，不写虚的。 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: "create",
    title: "起个书名",
    desc: "给作品起个名字就能开始，一句话简介可以之后再补。",
    note: "书名随时可改",
  },
  {
    key: "blueprint",
    title: "定下骨架",
    desc: "蓝图师给出主题、核心冲突、角色弧光与伏笔计划，逐版保存，随时可回溯。",
    note: "蓝图是整本书的底稿",
  },
  {
    key: "outline",
    title: "排好章节",
    desc: "大纲师按蓝图排出每章的节拍与冲突，批准后会直接填进写作表单。",
    note: "同时登记伏笔账本",
  },
  {
    key: "write",
    title: "开写正文",
    desc: "小说家生成定稿正文；提取师把它压成记忆，下一章还记得。",
    note: "你的改动会被风格画像学走",
  },
];

interface Props {
  /** 已有作品时，引导右上角出现「继续写作」直达工作台 */
  href?: string;
  onDismiss: () => void;
}

export default function Onboarding({ href, onDismiss }: Props) {
  return (
    <section id="how" className="shell scroll-mt-24 py-14 sm:py-20">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="max-w-2xl">
          <span className="eyebrow">四步成书</span>
          <h2 className="mt-3 text-[clamp(1.4rem,2.3vw,1.95rem)] font-medium text-zinc-900">
            从一句脑洞，到一章成稿
          </h2>
          <p className="mt-3 text-sm leading-7 text-zinc-500">
            五个 AI 角色分工协作，共用一份记忆层。你不必一次学完——按顺序走完这四步，
            第一本书的闭环就转起来了。
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {href && (
            <Link href={href} className="btn btn-primary">
              继续写作
            </Link>
          )}
          <button type="button" className="btn btn-ghost" onClick={onDismiss}>
            收起引导
          </button>
        </div>
      </div>

      <ol className="mt-10 grid gap-x-7 gap-y-10 md:grid-cols-2 xl:grid-cols-4 xl:gap-x-6">
        {ONBOARDING_STEPS.map((s, i) => (
          <li
            key={s.key}
            className="rise"
            style={{ "--rise-delay": `${i * 70}ms` } as CSSProperties}
          >
            {/* 编号印章 + 流向虚线（宽屏才画，窄屏靠留白分隔） */}
            <div className="flex items-center gap-3">
              <span className="seal h-7 w-7 shrink-0 text-[13px]">{i + 1}</span>
              <span
                aria-hidden
                className="hidden h-px flex-1 border-t border-dashed border-zinc-300 xl:block"
              />
            </div>

            <h3 className="mt-4 font-serif text-[1.05rem] font-medium text-zinc-900">{s.title}</h3>
            <p className="mt-2 text-[13px] leading-6 text-zinc-600">{s.desc}</p>
            <p className="mt-3 flex items-start gap-2 text-[12px] leading-5 text-zinc-400">
              <span
                aria-hidden
                className="mt-[7px] h-1 w-1 shrink-0 rounded-full"
                style={{ background: "color-mix(in oklab, var(--seal) 65%, transparent)" }}
              />
              {s.note}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
