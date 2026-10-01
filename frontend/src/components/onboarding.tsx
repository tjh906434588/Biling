/**
 * @file onboarding.tsx
 * 新手引导：首页「四步成书」引导区块，按 起书名 → 定蓝图 → 排大纲 → 开写 四步介绍工作流。
 * 核心机制：步骤文案由 ONBOARDING_STEPS 常量驱动（与产品里 5 个 AI 角色一一对应，不写虚的）；
 * 已有作品时右上角显示「继续写作」直达工作台，可一键收起引导。
 */
"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { ONBOARDING_STEPS } from "@/constants";

interface Props {
  /** 已有作品时，引导右上角出现「继续写作」直达工作台 */
  href?: string;
  onDismiss: () => void;
}

/**
 * 新手引导区块。
 * @param href 已有作品时指向工作台的「继续写作」链接；不传则不显示该按钮。
 * @param onDismiss 点击「收起引导」时回调（由父组件负责持久化隐藏）。
 */
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
            几个 AI 助手分工合作，共用一份『故事记忆』。不用一次学会，
            跟着四步走完第一本就通了。
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
