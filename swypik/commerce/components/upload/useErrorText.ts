"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { maxDurationSec, maxUploadMb } from "@/lib/video/limits";

/** Cod de eroare stabil (API / worker) → mesaj tradus (videoUpload.errors.*). */
export function useErrorText() {
  const t = useTranslations("videoUpload.errors");
  return useCallback(
    (code: string | null | undefined): string => {
      const key = (code || "generic").replace(/[^a-zA-Z0-9_]/g, "_");
      const values = { mb: maxUploadMb(), sec: maxDurationSec() };
      return t.has(key) ? t(key, values) : t("generic");
    },
    [t],
  );
}
