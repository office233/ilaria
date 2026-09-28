"use client";

import { useMemo } from "react";
import type { RecorderState, SegmentMarker } from "@/lib/reels/use-recorder";
import { cn } from "@/lib/ui/cn";

const SIZE = 80;
const RADIUS = 36;
const CIRC = 2 * Math.PI * RADIUS;

/** Butonul rotund de înregistrare: inel de progres + marcaje la fiecare pauză. */
export function RecordButton(props: {
  state: RecorderState;
  countdownValue: number;
  progressPct: number;
  segments: SegmentMarker[];
  maxMs: number;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  const { state, countdownValue, progressPct, segments, maxMs, disabled, onClick, label } = props;
  const dash = useMemo(() => (progressPct / 100) * CIRC, [progressPct]);
  const isRec = state === "recording";
  const isPaused = state === "paused";
  const showRing = isRec || isPaused;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || state === "stopping"}
      aria-label={label}
      className="relative flex items-center justify-center disabled:opacity-50"
      style={{ width: SIZE, height: SIZE }}
    >
      {showRing ? (
        <svg width={SIZE} height={SIZE} className="pointer-events-none absolute inset-0 -rotate-90" aria-hidden>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" className="stroke-white/25" strokeWidth={4} />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            className={isPaused ? "stroke-warning" : "stroke-brand"}
            strokeWidth={4}
            strokeDasharray={`${dash} ${CIRC}`}
            strokeLinecap="round"
          />
          {segments.map((seg, idx) => {
            const angle = Math.min(1, seg.endMs / maxMs) * 2 * Math.PI;
            return (
              <circle
                key={idx}
                cx={SIZE / 2 + RADIUS * Math.cos(angle)}
                cy={SIZE / 2 + RADIUS * Math.sin(angle)}
                r={2.5}
                className="fill-white"
              />
            );
          })}
        </svg>
      ) : null}
      <span className={cn("absolute inset-0 rounded-full border-[3px]", showRing ? "border-transparent" : "border-white")} />
      {state === "countdown" && countdownValue > 0 ? (
        <span className="text-2xl font-black text-white">{countdownValue}</span>
      ) : isRec ? (
        <span className="h-7 w-7 rounded-md bg-white" />
      ) : (
        <span className="h-6 w-6 rounded-full bg-brand" />
      )}
    </button>
  );
}
