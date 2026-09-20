/**
 * 书封：按书名确定性地生成一枚「传统色封面」。
 * 同一个书名永远得到同一套配色，不需要上传封面图也能让书架像书店。
 */
const PALETTES = [
  { from: "#2b3c58", to: "#1a2537", ink: "#f1ece1" }, // 藏青
  { from: "#9e3a2a", to: "#6b2419", ink: "#faf1e8" }, // 朱砂
  { from: "#2f4a38", to: "#1c3025", ink: "#edf2e6" }, // 墨绿
  { from: "#8a5a24", to: "#5c3a15", ink: "#f8efdd" }, // 赭石
  { from: "#33507e", to: "#1f3157", ink: "#ecf1f9" }, // 靛蓝
  { from: "#6b4530", to: "#452b1d", ink: "#f6ebe1" }, // 檀色
  { from: "#37322b", to: "#201d19", ink: "#ece6d9" }, // 松烟
  { from: "#3a4a5e", to: "#242e3c", ink: "#edf1f5" }, // 青金
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 书名越长字号越小，保证竖排时不溢出封面。 */
function titleSize(len: number): number {
  if (len <= 3) return 30;
  if (len <= 5) return 25;
  if (len <= 7) return 21;
  if (len <= 10) return 17;
  return 14;
}

export default function NovelCover({
  title,
  seed = 0,
  className = "",
}: {
  title: string;
  /** 书架中的序号：让相邻几本书错开配色，避免一排都是蓝 */
  seed?: number;
  className?: string;
}) {
  const p = PALETTES[(hash(title) + seed * 3) % PALETTES.length];
  const clean = title.trim() || "未命名";
  const size = titleSize(clean.length);

  return (
    <div
      className={`relative overflow-hidden rounded-[5px] ${className}`}
      style={{ background: `linear-gradient(152deg, ${p.from} 0%, ${p.to} 100%)` }}
      aria-hidden
    >
      {/* 内框（函套压印） */}
      <div
        className="absolute inset-[7px] rounded-[2px]"
        style={{ border: `1px solid ${p.ink}33` }}
      />
      {/* 书脊高光 */}
      <div
        className="absolute inset-y-0 left-0 w-[6px]"
        style={{ background: `linear-gradient(90deg, ${p.ink}26, transparent)` }}
      />

      {/* 竖排书名 */}
      <div className="absolute inset-x-0 top-0 bottom-12 flex items-start justify-center pt-7">
        <span
          className="vertical overflow-hidden font-serif font-medium leading-none"
          style={{
            color: p.ink,
            fontSize: `${size}px`,
            letterSpacing: "0.2em",
            maxHeight: "calc(100% - 0.5rem)",
            textShadow: "0 1px 0 rgba(0,0,0,.18)",
          }}
        >
          {clean}
        </span>
      </div>

      {/* 落款印 */}
      <div className="absolute inset-x-0 bottom-4 flex justify-center">
        <span
          className="grid h-[18px] w-[18px] place-items-center rounded-[3px] font-serif text-[11px] leading-none"
          style={{ background: p.ink, color: p.to, opacity: 0.9 }}
        >
          灵
        </span>
      </div>

      {/* 斜向柔光 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 70% at 22% 0%, rgba(255,255,255,.18), transparent 62%)",
        }}
      />
    </div>
  );
}
