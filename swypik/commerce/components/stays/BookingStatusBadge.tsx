"use client";

import { useTranslations } from "next-intl";
import { Badge, type BadgeProps } from "@/components/ui/Badge";

const TONE: Record<string, BadgeProps["tone"]> = {
    pending: "warning",
    requested: "info",
    confirmed: "success",
    completed: "neutral",
    declined: "danger",
    expired: "neutral",
    cancelled: "danger",
};

export function BookingStatusBadge({ status }: { status: string }) {
    const t = useTranslations("staysUi");
    const known = status in TONE;
    return <Badge tone={TONE[status] ?? "neutral"}>{known ? t(`status.${status}`) : status}</Badge>;
}
