"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui/Toast";
import { absoluteUrl, profilePath } from "@/lib/social/links";

/** Share nativ (mobil) cu fallback la copiere în clipboard. Anularea foii native nu e eroare. */
export function useShareProfile(username: string, displayName: string) {
  const t = useTranslations("social.profile");
  const { toast } = useToast();
  return useCallback(async () => {
    const url = absoluteUrl(window.location.origin, profilePath(username));
    const data = { title: t("shareTitle", { name: displayName }), url };
    if (typeof navigator.share === "function") {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: t("linkCopied"), tone: "success" });
    } catch {
      toast({ title: t("shareError"), tone: "danger" });
    }
  }, [displayName, t, toast, username]);
}
