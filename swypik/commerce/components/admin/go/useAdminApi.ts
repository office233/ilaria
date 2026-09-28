"use client";

import { useCallback, useEffect, useState } from "react";
import { goFetch } from "@/components/go/format";

/** GET periodic (opțional) al unui endpoint admin; `reload` după mutații. */
export function useAdminResource<T>(url: string, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await goFetch<T>(url);
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.error);
  }, [url]);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const iv = setInterval(() => void reload(), pollMs);
    return () => clearInterval(iv);
  }, [reload, pollMs]);

  return { data, error, reload };
}

export const ADMIN_POLL_MS =
  Number(process.env.NEXT_PUBLIC_GO_ADMIN_POLL_MS) > 0 ? Number(process.env.NEXT_PUBLIC_GO_ADMIN_POLL_MS) : 10_000;
