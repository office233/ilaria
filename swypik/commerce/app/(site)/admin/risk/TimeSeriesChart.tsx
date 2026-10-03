import { TrendingUp } from "lucide-react";
import { getTranslations } from "next-intl/server";

export type TimeSeriesPoint = {
  day: string; // YYYY-MM-DD
  flagged: number;
  approvals: number;
  blocks: number;
  autoBlocks: number;
};

export type TimeSeries30d = {
  points: TimeSeriesPoint[];
  totalFlagged: number;
  totalApprovals: number;
  totalBlocks: number;
  totalAutoBlocks: number;
};

const W = 600;
const H = 120;
const PAD_X = 28;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

export async function TimeSeriesChart({ data }: { data: TimeSeries30d }) {
  const t = await getTranslations("adminRisk");
  const pts = data.points;
  const hasData = data.totalFlagged + data.totalApprovals + data.totalBlocks + data.totalAutoBlocks > 0;
  const max = Math.max(
    1,
    ...pts.map((p) => Math.max(p.flagged, p.approvals, p.blocks, p.autoBlocks)),
  );
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const stepX = pts.length > 1 ? innerW / (pts.length - 1) : 0;

  const buildPath = (key: keyof TimeSeriesPoint) =>
    pts
      .map((p, i) => {
        const x = PAD_X + i * stepX;
        const v = Number(p[key]) || 0;
        const y = PAD_TOP + innerH - (v / max) * innerH;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const first = pts[0]?.day || "";
  const last = pts[pts.length - 1]?.day || "";
  const mid = pts[Math.floor(pts.length / 2)]?.day || "";

  return (
    <div className="bg-white border border-[#E5E5E5] rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-gray-700 flex items-center gap-1"><TrendingUp size={14} /> {t("trendLast30Days")}</div>
        <div className="flex gap-3 text-[10px]">
          <Legend color="#6366f1" label={t("legendFlagged", { count: data.totalFlagged })} />
          <Legend color="#10b981" label={t("legendApprove", { count: data.totalApprovals })} />
          <Legend color="#ef4444" label={t("legendBlock", { count: data.totalBlocks })} />
          <Legend color="#f59e0b" label={t("legendAutoBlock", { count: data.totalAutoBlocks })} />
        </div>
      </div>

      {!hasData ? (
        <div className="text-[11px] text-gray-400 italic py-6 text-center">
          {t("noSignals")}
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto"
          role="img"
          aria-label={t("chartAria")}
        >
          {/* Y axis gridlines */}
          {[0, 0.5, 1].map((r) => {
            const y = PAD_TOP + innerH - r * innerH;
            return (
              <g key={r}>
                <line
                  x1={PAD_X}
                  y1={y}
                  x2={W - PAD_X}
                  y2={y}
                  stroke="#f3f4f6"
                  strokeWidth="1"
                />
                <text x={4} y={y + 3} fontSize="9" fill="#9ca3af">
                  {Math.round(max * r)}
                </text>
              </g>
            );
          })}

          {/* Lines */}
          <path d={buildPath("flagged")} fill="none" stroke="#6366f1" strokeWidth="1.5" />
          <path d={buildPath("approvals")} fill="none" stroke="#10b981" strokeWidth="1.5" />
          <path d={buildPath("blocks")} fill="none" stroke="#ef4444" strokeWidth="1.5" />
          <path d={buildPath("autoBlocks")} fill="none" stroke="#f59e0b" strokeWidth="1.5" />

          {/* X axis labels */}
          <text x={PAD_X} y={H - 4} fontSize="9" fill="#9ca3af">
            {first}
          </text>
          <text x={W / 2} y={H - 4} fontSize="9" fill="#9ca3af" textAnchor="middle">
            {mid}
          </text>
          <text x={W - PAD_X} y={H - 4} fontSize="9" fill="#9ca3af" textAnchor="end">
            {last}
          </text>
        </svg>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-gray-600">
      <span
        className="inline-block w-2.5 h-2.5 rounded-sm"
        style={{ background: color }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
