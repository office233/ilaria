"use client";

import { useTranslations } from "next-intl";
import { Share2 } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { useToast } from "@/components/ui/Toast";

/** Native share sheet when available, otherwise copy the link (desktop fallback). */
export default function ShareButton({ title }: { title: string }) {
  const t = useTranslations("news");
  const { toast } = useToast();

  const share = async () => {
    const url = window.location.href;
    if (typeof navigator.share === "function") {
      await navigator.share({ title, url }).catch(() => null);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: t("sharing.copied"), tone: "success" });
    } catch {
      toast({ title: t("sharing.failed"), tone: "danger" });
    }
  };

  return (
    <IconButton label={t("sharing.label")} onClick={share}>
      <Share2 className="h-5 w-5" aria-hidden />
    </IconButton>
  );
}
