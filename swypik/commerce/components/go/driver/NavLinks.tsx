"use client";

import { Navigation } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { googleMapsLink, wazeLink } from "../navigation";

/** Handoff navigare (Google Maps / Waze) către un punct. */
export default function NavLinks({ lat, lng }: { lat: number; lng: number }) {
  const t = useTranslations("goDriver");
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button asChild variant="secondary">
        <a href={googleMapsLink(lat, lng)} target="_blank" rel="noopener noreferrer">
          <Navigation aria-hidden className="h-4 w-4" />
          {t("nav.gmaps")}
        </a>
      </Button>
      <Button asChild variant="secondary">
        <a href={wazeLink(lat, lng)} target="_blank" rel="noopener noreferrer">
          <Navigation aria-hidden className="h-4 w-4" />
          {t("nav.waze")}
        </a>
      </Button>
    </div>
  );
}
