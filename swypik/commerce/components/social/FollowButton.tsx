"use client";

import { useCallback } from "react";
import { Check, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { haptic } from "@/lib/haptic";
import { cn } from "@/lib/ui/cn";
import { useAuthRedirect } from "./useAuthRedirect";
import { toggleOutcome, useOptimisticToggle, type ToggleState } from "./useOptimisticToggle";

export type FollowButtonProps = {
  userId: string;
  initialFollowing: boolean;
  /** Numărul de urmăritori afișat de părinte (actualizat optimist + reconciliat). */
  initialFollowerCount?: number;
  /** `button`: buton text (profil, liste); `badge`: „+" rotund peste avatar (feed). */
  variant?: "button" | "badge";
  size?: "sm" | "md";
  block?: boolean;
  onChange?: (state: { following: boolean; followerCount: number }) => void;
  /** Eticheta accesibilă a badge-ului (ex. „Urmărește {nume}"); implicit „Urmărește". */
  label?: string;
  className?: string;
};

/**
 * Follow/unfollow optimist și idempotent (PUT/DELETE /api/users/[id]/follow).
 * Blocările → mesaj; 401 → autentificare.
 */
export default function FollowButton({
  userId,
  initialFollowing,
  initialFollowerCount = 0,
  variant = "button",
  size = "md",
  block,
  onChange,
  label,
  className,
}: FollowButtonProps) {
  const t = useTranslations("social.follow");
  const { toast } = useToast();
  const toAuth = useAuthRedirect();

  const send = useCallback(
    async (next: boolean) => {
      try {
        const res = await fetch(`/api/users/${encodeURIComponent(userId)}/follow`, {
          method: next ? "PUT" : "DELETE",
          credentials: "include",
        });
        return toggleOutcome(res, (d) => ({ active: Boolean(d.following), count: Number(d.follower_count) || 0 }));
      } catch {
        return { ok: false as const, reason: "error" as const };
      }
    },
    [userId],
  );

  const onSettled = useCallback(
    (s: ToggleState) => onChange?.({ following: s.active, followerCount: s.count }),
    [onChange],
  );
  const onError = useCallback(
    (reason: string) => {
      if (reason === "unauthorized") return toAuth();
      const title = reason === "blocked" ? t("blocked") : reason === "rate_limited" ? t("rateLimited") : t("error");
      toast({ title, tone: "danger" });
    },
    [t, toast, toAuth],
  );

  const { state, toggle } = useOptimisticToggle(
    { active: initialFollowing, count: initialFollowerCount },
    send,
    { resetKey: userId, onSettled, onError },
  );

  const onClick = () => {
    haptic("tap");
    void toggle();
  };

  if (variant === "badge") {
    if (state.active) return null;
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label ?? t("follow")}
        className={cn(
          "relative grid h-6 w-6 place-items-center rounded-full bg-brand text-brand-fg shadow-elev-1 before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
          className,
        )}
      >
        <Plus aria-hidden className="h-4 w-4" />
      </button>
    );
  }

  return (
    <Button
      type="button"
      size={size}
      block={block}
      variant={state.active ? "secondary" : "primary"}
      aria-pressed={state.active}
      onClick={onClick}
      className={cn("min-w-28", className)}
    >
      {state.active ? <Check aria-hidden className="h-4 w-4" /> : null}
      {state.active ? t("following") : t("follow")}
    </Button>
  );
}

export { FollowButton };
