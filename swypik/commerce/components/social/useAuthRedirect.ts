"use client";

import { useCallback } from "react";
import { useRouter } from "@/lib/i18n/navigation";

/**
 * La un 401 (acțiune care cere cont): trimite la autentificare și revine pe
 * pagina curentă după login.
 */
export function useAuthRedirect(): () => void {
  const router = useRouter();
  return useCallback(() => {
    const next = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
    router.push(`/auth?next=${encodeURIComponent(next)}`);
  }, [router]);
}
