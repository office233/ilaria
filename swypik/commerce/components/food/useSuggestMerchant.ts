"use client";

/** „Sugerează proprietarului” — POST /api/merchants/[id]/suggest + memorare locală. */
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui/Toast";
import { haptic } from "@/lib/haptic";
import { readFoodError, useFoodError } from "./useFoodError";

const KEY = "swypik_food_suggested";

function readSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function useSuggestMerchant() {
  const t = useTranslations("foodHub");
  const errorText = useFoodError();
  const { toast } = useToast();
  const [suggested, setSuggested] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => setSuggested(readSet()), []);

  const suggest = useCallback(
    async (merchantId: string) => {
      setBusyId(merchantId);
      try {
        const res = await fetch(`/api/merchants/${merchantId}/suggest`, { method: "POST" });
        if (!res.ok) {
          toast({ title: errorText(await readFoodError(res)), tone: "danger" });
          return;
        }
        const data = (await res.json()) as { suggestion_count?: number };
        haptic("success");
        setCounts((c) => ({ ...c, [merchantId]: Number(data.suggestion_count ?? 0) }));
        setSuggested((prev) => {
          const next = new Set(prev).add(merchantId);
          try {
            localStorage.setItem(KEY, JSON.stringify(Array.from(next).slice(-200)));
          } catch {
            /* ignore */
          }
          return next;
        });
        toast({ title: t("suggestThanks"), description: t("suggestThanksSub"), tone: "success" });
      } catch {
        toast({ title: errorText("server_error"), tone: "danger" });
      } finally {
        setBusyId(null);
      }
    },
    [errorText, t, toast],
  );

  return { suggested, counts, busyId, suggest };
}
