"use client";

import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { isEnabledClient } from "@/lib/feature-flags-client";
import { dmEntryHref, type DmEntry } from "@/lib/dm/links";
import { Link } from "@/lib/i18n/navigation";

type Props = {
  entry: DmEntry;
  /** `icon` = IconButton (headere), `button` = buton cu text. */
  appearance?: "button" | "icon";
  /** Cheie din `dm.entry` (ex. messageSeller, contactRestaurant). */
  labelKey?: "message" | "messageSeller" | "contactSeller" | "contactRestaurant" | "contactBuyer";
  variant?: "primary" | "secondary";
  block?: boolean;
  className?: string;
};

/**
 * Butonul „Mesaj” din profil / produs / magazin / comenzi. Duce la
 * `/messages/new?<kind>=<id>`; serverul rezolvă interlocutorul. Ascuns când
 * Messenger e oprit.
 */
export function MessageButton({ entry, appearance = "button", labelKey = "message", variant = "secondary", block, className }: Props) {
  const t = useTranslations("dm.entry");
  if (!isEnabledClient("messenger")) return null;
  const href = dmEntryHref(entry);
  const label = t(labelKey);

  if (appearance === "icon") {
    return (
      <IconButton asChild label={label} className={className}>
        <Link href={href}>
          <MessageCircle aria-hidden />
        </Link>
      </IconButton>
    );
  }
  return (
    <Button asChild variant={variant} block={block} className={className}>
      <Link href={href}>
        <MessageCircle className="h-4 w-4" aria-hidden />
        {label}
      </Link>
    </Button>
  );
}
