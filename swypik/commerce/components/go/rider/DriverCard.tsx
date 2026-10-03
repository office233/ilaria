"use client";

import { Phone, Share2, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { RideDriver } from "../types";

const EMERGENCY_NUMBER = process.env.NEXT_PUBLIC_EMERGENCY_NUMBER || "112";

type Props = {
  driver: RideDriver;
  onShare: (() => void) | null;
};

/** Șoferul atribuit: nume, mașină, număr, rating, apel, distribuire cursă, SOS. */
export default function DriverCard({ driver, onShare }: Props) {
  const t = useTranslations("go");
  const car = [driver.vehicle_make, driver.vehicle_model, driver.vehicle_color].filter(Boolean).join(" ");
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar name={driver.full_name} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-fg">{driver.full_name}</p>
          <p className="truncate text-sm text-muted">
            {car || driver.vehicle_type}
            {driver.rating ? ` · ★ ${Number(driver.rating).toFixed(2)}` : ""}
          </p>
        </div>
        {driver.vehicle_plate ? (
          <Badge tone="solid" className="font-mono tracking-wider">
            {driver.vehicle_plate}
          </Badge>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {driver.phone ? (
          <Button asChild variant="secondary">
            <a href={`tel:${driver.phone}`}>
              <Phone aria-hidden className="h-4 w-4" />
              {t("driver.call")}
            </a>
          </Button>
        ) : (
          <span />
        )}
        {onShare ? (
          <Button variant="secondary" onClick={onShare}>
            <Share2 aria-hidden className="h-4 w-4" />
            {t("share.button")}
          </Button>
        ) : (
          <span />
        )}
        <Button asChild variant="danger">
          <a href={`tel:${EMERGENCY_NUMBER}`}>
            <ShieldAlert aria-hidden className="h-4 w-4" />
            {t("share.sos")}
          </a>
        </Button>
      </div>
    </Card>
  );
}
