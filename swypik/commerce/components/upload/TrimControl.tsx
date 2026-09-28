"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { formatDuration } from "@/lib/upload/media";
import { VIDEO_LIMITS } from "@/lib/video/limits";
import type { TrimRange } from "@/lib/upload/trim";

/** Două glisoare (început / sfârșit) + durata rezultată. Accesibil din tastatură. */
export function TrimControl(props: { durationMs: number; value: TrimRange; onChange: (v: TrimRange, moved: "start" | "end") => void }) {
  const t = useTranslations("videoUpload.edit");
  const id = useId();
  const { durationMs, value, onChange } = props;
  const step = durationMs > 60_000 ? 500 : 100;
  const length = value.endMs - value.startMs;
  const startPct = (value.startMs / durationMs) * 100;
  const endPct = (value.endMs / durationMs) * 100;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-fg">{t("trim")}</span>
        <span className="text-sm tabular-nums text-muted">
          {t("selected", { length: formatDuration(length), total: formatDuration(durationMs) })}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-surface-2" aria-hidden>
        <div className="absolute inset-y-0 rounded-full bg-brand" style={{ left: `${startPct}%`, right: `${100 - endPct}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {(["start", "end"] as const).map((edge) => (
          <div key={edge} className="space-y-1">
            <label htmlFor={`${id}-${edge}`} className="flex justify-between text-xs text-muted">
              <span>{edge === "start" ? t("start") : t("end")}</span>
              <span className="tabular-nums">{formatDuration(edge === "start" ? value.startMs : value.endMs)}</span>
            </label>
            <input
              id={`${id}-${edge}`}
              type="range"
              min={0}
              max={durationMs}
              step={step}
              value={edge === "start" ? value.startMs : value.endMs}
              onChange={(e) => {
                const v = Number(e.target.value);
                onChange(edge === "start" ? { ...value, startMs: v } : { ...value, endMs: v }, edge);
              }}
              className="h-11 w-full accent-brand"
            />
          </div>
        ))}
      </div>
      {durationMs > VIDEO_LIMITS.maxDurationMs ? (
        <p className="text-xs text-warning">{t("tooLongHint", { max: formatDuration(VIDEO_LIMITS.maxDurationMs) })}</p>
      ) : null}
    </div>
  );
}
