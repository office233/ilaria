import { code128Bars } from "@/lib/barcode/code128";

/** Cod de bare Code 128 real (scanabil), desenat în SVG. */
export function Code128Barcode({ value, label }: { value: string; label: string }) {
  let data: ReturnType<typeof code128Bars> | null = null;
  try {
    data = code128Bars(value);
  } catch {
    data = null;
  }
  if (!data) return <span className="font-mono text-sm font-black tracking-widest text-fg">{value}</span>;
  return (
    <div className="flex flex-col items-center">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${data.totalModules} 50`}
        preserveAspectRatio="none"
        className="w-full max-w-[320px] h-[60px] bg-surface text-fg"
      >
        {data.bars.map((bar, i) => (
          <rect key={i} x={bar.x} y={0} width={bar.width} height={50} fill="currentColor" />
        ))}
      </svg>
      <span className="font-mono text-sm font-black tracking-widest text-fg mt-1">{value}</span>
    </div>
  );
}
