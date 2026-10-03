"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

/** Cod de eroare stabil din API-urile Food → mesaj tradus (foodHub.errors.<code>). */
export function useFoodError() {
  const t = useTranslations("foodHub.errors");
  return useCallback(
    (code: string | null | undefined): string => (code && t.has(code) ? t(code) : t("server_error")),
    [t],
  );
}

/** Citește `{ code }` din răspunsul unui API Food (fără să arunce). */
export async function readFoodError(res: Response): Promise<string | null> {
  const data = (await res.json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
  if (typeof data?.code === "string") return data.code;
  return typeof data?.error === "string" && /^[a-z_]+$/.test(data.error) ? data.error : null;
}
