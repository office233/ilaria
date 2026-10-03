"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HeartOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";

/** Elimină un produs din salvate și reîmprospătează lista. */
export function SavedRemoveButton({ productId }: { productId: string }) {
  const t = useTranslations("shopBuyer.saved");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      label={t("remove")}
      variant="overlay"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/products/${productId}/save`, { method: "DELETE", credentials: "include" }).catch(() => null);
        router.refresh();
        setBusy(false);
      }}
    >
      <HeartOff aria-hidden />
    </IconButton>
  );
}
