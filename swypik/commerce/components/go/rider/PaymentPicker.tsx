"use client";

import { Banknote, CreditCard } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";

type Method = "card" | "cash";

/** Doar metodele permise de server (go_settings + taxe datorate). */
export default function PaymentPicker({
  methods,
  value,
  onChange,
}: {
  methods: Method[];
  value: Method | null;
  onChange: (m: Method) => void;
}) {
  const t = useTranslations("go");
  if (!methods.length) {
    return <p className="rounded-control bg-warning-soft p-3 text-sm text-warning">{t("noPaymentMethod")}</p>;
  }
  return (
    <div role="radiogroup" aria-label={t("paymentMethod")} className="flex gap-2">
      {methods.map((m) => {
        const Icon = m === "card" ? CreditCard : Banknote;
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m)}
            className={cn(
              "flex h-11 flex-1 items-center justify-center gap-2 rounded-control border text-sm font-semibold transition-colors duration-fast",
              active ? "border-brand bg-brand-soft text-brand-soft-fg" : "border-subtle bg-surface text-fg hover:bg-surface-2",
            )}
          >
            <Icon aria-hidden className="h-4 w-4" />
            {m === "card" ? t("payCard") : t("payCash")}
          </button>
        );
      })}
    </div>
  );
}
