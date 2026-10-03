"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input, Field } from "@/components/ui/Input";

export type UsernameStatus = "idle" | "checking" | "ok" | "username_invalid" | "username_reserved" | "username_taken";

const PATTERN = /^[a-z0-9_]{3,30}$/;
const DEBOUNCE_MS = 400;

/** Câmp username cu validare locală + verificare de disponibilitate (debounce). */
export function UsernameField({
  value,
  original,
  onChange,
  onStatus,
}: {
  value: string;
  original: string;
  onChange: (value: string) => void;
  onStatus: (status: UsernameStatus) => void;
}) {
  const t = useTranslations("social.edit");
  const [status, setStatus] = useState<UsernameStatus>("idle");

  useEffect(() => {
    let cancelled = false;
    const update = (s: UsernameStatus) => {
      if (cancelled) return;
      setStatus(s);
      onStatus(s);
    };
    if (value === original) return update("idle");
    if (!PATTERN.test(value)) return update("username_invalid");
    update("checking");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/username-check?username=${encodeURIComponent(value)}`, { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return update("idle");
        update(data.available ? "ok" : ((data.reason as UsernameStatus) ?? "username_taken"));
      } catch {
        update("idle");
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, original, onStatus]);

  const error = status.startsWith("username_") ? t(`errors.${status}`) : undefined;
  const hint = status === "ok" ? t("usernameAvailable") : value !== original ? t("usernameAliasHint") : t("usernameHint");

  return (
    <Field label={t("username")} hint={error ? undefined : hint} error={error}>
      {(field) => (
        <Input
          {...field}
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, ""))}
          maxLength={30}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          leadingIcon={<span className="text-muted">@</span>}
          trailing={
            status === "checking" ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin text-muted" />
            ) : status === "ok" ? (
              <Check aria-label={t("usernameAvailable")} className="h-4 w-4 text-success" />
            ) : null
          }
        />
      )}
    </Field>
  );
}
