"use client";

/** Rating după cursă (pasager → șofer sau șofer → pasager): POST /api/rides/[id]/rating. */
import { useState } from "react";
import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui/cn";
import { goFetch } from "./format";

export default function RatingForm({ rideId, prompt, onDone }: { rideId: string; prompt: string; onDone: () => void }) {
  const t = useTranslations("go");
  const [stars, setStars] = useState(0);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!stars) return;
    setBusy(true);
    const r = await goFetch(`/api/rides/${rideId}/rating`, { method: "POST", body: JSON.stringify({ stars }) });
    setBusy(false);
    if (r.ok || r.status === 409) onDone();
  };

  return (
    <div className="space-y-2 text-center">
      <p className="text-sm font-semibold text-fg">{prompt}</p>
      <div className="flex justify-center gap-1" role="radiogroup" aria-label={prompt}>
        {[1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={stars === s}
            aria-label={t("starsAria", { count: s })}
            onClick={() => setStars(s)}
            className="flex h-11 w-11 items-center justify-center rounded-control"
          >
            <Star aria-hidden className={cn("h-7 w-7", s <= stars ? "fill-warning text-warning" : "text-subtle")} />
          </button>
        ))}
      </div>
      <Button block loading={busy} disabled={!stars} onClick={send}>
        {t("receipt.rateSend")}
      </Button>
    </div>
  );
}
