"use client";

import { Minus, Plus, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";

/** Selector de oaspeți cu butoane de 44px (fără <select> mic pe telefon). */
export function GuestStepper({ value, onChange, max }: { value: number; onChange: (n: number) => void; max: number }) {
    const t = useTranslations("staysUi");
    return (
        <div className="flex min-h-11 items-center gap-3 rounded-control border border-subtle bg-surface px-3.5 py-1">
            <Users className="h-5 w-5 shrink-0 text-subtle" aria-hidden />
            <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted">{t("guestsLabel")}</span>
                <span className="block text-base text-fg" aria-live="polite">
                    {t("guestsCount", { count: value })}
                </span>
            </span>
            <IconButton label={t("fewerGuests")} variant="secondary" disabled={value <= 1} onClick={() => onChange(value - 1)}>
                <Minus aria-hidden />
            </IconButton>
            <IconButton label={t("moreGuests")} variant="secondary" disabled={value >= max} onClick={() => onChange(value + 1)}>
                <Plus aria-hidden />
            </IconButton>
        </div>
    );
}
