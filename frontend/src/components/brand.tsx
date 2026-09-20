import Link from "next/link";

/** 品牌标记：朱砂印章 + 笔灵。首页与工作台共用。 */
export default function Brand({
  href = "/",
  size = "md",
  showLatin = true,
}: {
  href?: string;
  size?: "md" | "sm";
  showLatin?: boolean;
}) {
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
