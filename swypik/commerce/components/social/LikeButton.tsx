"use client";

import { useCallback } from "react";
import { Heart } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useToast } from "@/components/ui/Toast";
import { haptic } from "@/lib/haptic";
import { formatCount } from "@/lib/social/format";
import { cn } from "@/lib/ui/cn";
import { toggleOutcome, useOptimisticToggle, type ToggleState } from "./useOptimisticToggle";

export type LikeButtonProps = {
  targetId: string;
  /** Video (implicit) sau comentariu — același tabel `likes`, rute diferite. */
  target?: "video" | "comment";
  initialLiked: boolean;
  initialCount: number;
  /** `overlay`: coloană iconiță + număr peste video (feed); `inline`: rând compact (comentarii). */
  variant?: "overlay" | "inline";
  onChange?: (state: { liked: boolean; count: number }) => void;
  className?: string;
};

const ENDPOINT = {
  video: (id: string) => `/api/videos/${encodeURIComponent(id)}/like`,
  comment: (id: string) => `/api/comments/${encodeURIComponent(id)}/like`,
};

/**
 * Buton de like reutilizabil: optimist, idempotent (PUT = like, DELETE = unlike),
 * reconciliat cu contorul real din răspuns. Merge și pentru vizitatori anonimi.
 */
export default function LikeButton({
  targetId,
  target = "video",
  initialLiked,
  initialCount,
  variant = "overlay",
  onChange,
  className,
}: LikeButtonProps) {
  const t = useTranslations("social.like");
  const locale = useLocale();
  const { toast } = useToast();

  const send = useCallback(
    async (next: boolean) => {
      try {
        const res = await fetch(ENDPOINT[target](targetId), {
          method: next ? "PUT" : "DELETE",
          credentials: "include",
        });
        return toggleOutcome(res, (d) => ({ active: Boolean(d.liked), count: Number(d.like_count) || 0 }));
      } catch {
        return { ok: false as const, reason: "error" as const };
      }
    },
    [target, targetId],
  );

  const onSettled = useCallback(
    (s: ToggleState) => onChange?.({ liked: s.active, count: s.count }),
    [onChange],
  );
  const onError = useCallback(
    (reason: string) => toast({ title: reason === "rate_limited" ? t("rateLimited") : t("error"), tone: "danger" }),
    [toast, t],
  );

  const { state, toggle } = useOptimisticToggle(
    { active: initialLiked, count: initialCount },
    send,
    { resetKey: `${target}:${targetId}`, onSettled, onError },
  );

  const label = state.active ? t("unlike") : t("like");
  const count = formatCount(state.count, locale);

  if (variant === "inline") {
    return (
      <button
        type="button"
        aria-pressed={state.active}
        aria-label={label}
        onClick={() => {
          haptic("tap");
          void toggle();
        }}
        className={cn(
          "inline-flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-control text-xs font-semibold text-muted transition-colors duration-fast hover:text-fg",
          state.active && "text-danger hover:text-danger",
          className,
        )}
      >
        <Heart aria-hidden className="h-4 w-4" fill={state.active ? "currentColor" : "none"} />
        {state.count > 0 ? <span>{count}</span> : null}
      </button>
    );
  }

  // Overlay = rail-ul feed-ului: aceeași formă ca RailButton (iconiță 28px + număr, țintă ≥ 48px).
  return (
    <button
      type="button"
      aria-pressed={state.active}
      aria-label={label}
      onClick={() => {
        haptic("tap");
        void toggle();
      }}
      className={cn(
        "flex min-h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-control text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        className,
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center drop-shadow-md motion-safe:transition-transform motion-safe:duration-fast motion-safe:active:scale-90">
        <Heart aria-hidden className={cn("h-7 w-7", state.active ? "fill-danger text-danger" : "fill-transparent")} />
      </span>
      <span className="text-xs font-semibold tabular-nums drop-shadow">{count}</span>
    </button>
  );
}

export { LikeButton };
