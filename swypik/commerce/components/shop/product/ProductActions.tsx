"use client";

import { useEffect, useState } from "react";
import { Heart, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { useToast } from "@/components/ui/Toast";
import { useRouter } from "@/lib/i18n/navigation";
import { cn } from "@/lib/ui/cn";

/** Salvează (wishlist) + distribuie — în header-ul paginii de produs. */
export function ProductActions({ productId, title }: { productId: string; title: string }) {
  const t = useTranslations("shopBuyer.product");
  const { toast } = useToast();
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/products/${productId}/save`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { saved?: boolean } | null) => {
        if (!cancelled && typeof d?.saved === "boolean") setSaved(d.saved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const toggleSave = async () => {
    if (busy) return;
    const next = !saved;
    setSaved(next);
    setBusy(true);
    try {
      const res = await fetch(`/api/products/${productId}/save`, { method: next ? "POST" : "DELETE", credentials: "include" });
      if (res.status === 401) {
        setSaved(!next);
        router.push(`/account?redirect=${encodeURIComponent(`/product/${productId}`)}`);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      toast({ title: next ? t("savedToast") : t("unsavedToast"), tone: "success" });
    } catch {
      setSaved(!next);
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast({ title: t("shareCopied"), tone: "success" });
    } catch {
      /* utilizatorul a anulat */
    }
  };

  return (
    <>
      <IconButton label={saved ? t("unsaveAria") : t("saveAria")} aria-pressed={saved} onClick={() => void toggleSave()} disabled={busy}>
        <Heart aria-hidden className={cn(saved && "fill-danger text-danger")} />
      </IconButton>
      <IconButton label={t("shareAria")} onClick={() => void share()}>
        <Share2 aria-hidden />
      </IconButton>
    </>
  );
}
