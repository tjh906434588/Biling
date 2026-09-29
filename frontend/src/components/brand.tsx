/**
 * @file brand.tsx
 * 品牌标识：朱砂印章 + 「笔灵」字标 + BILING 拉丁字母行。
 * 无状态纯展示组件，首页与工作台顶栏共用，支持尺寸/文案切换。
 */
import Link from "next/link";

/** 品牌标记：朱砂印章 + 笔灵。首页与工作台共用。 */
export default function Brand({
  href = "/", // 点击跳转地址，默认首页
  size = "md", // 尺寸档位：md=标准 / sm=紧凑
  showLatin = true, // 是否显示 BILING 拉丁字母行
}: {
  href?: string;
  size?: "md" | "sm";
  showLatin?: boolean;
}) {
  // 按尺寸档位切换的 Tailwind 类：box=朱砂印章尺寸，word=「笔灵」字标尺寸
  const box = size === "md" ? "h-8 w-8 text-[15px]" : "h-7 w-7 text-[13px]";
  const word = size === "md" ? "text-[17px] tracking-[0.16em]" : "text-[15px] tracking-[0.14em]";

  return (
    <Link href={href} className="group flex items-center gap-2.5">
      <span
        className={`seal ${box} transition-transform duration-500 ease-[cubic-bezier(.22,.61,.36,1)] group-hover:-rotate-6`}
      >
        灵
      </span>
      <span className="flex flex-col leading-none">
        <span className={`font-serif font-medium text-zinc-900 ${word}`}>笔灵</span>
        {showLatin && (
          <span className="mt-[3px] text-[9px] font-medium tracking-[0.34em] text-zinc-400">
            BILING
          </span>
        )}
      </span>
    </Link>
  );
}
