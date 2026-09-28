"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";

/**
 * Stripe Connect — randat DOAR când `readiness.connectAvailable`.
 * Stripe revine la /creator/payouts?success=1 (gata) sau ?refresh=1 (link expirat → reluăm onboarding-ul).
 */
export function ConnectSection({ accountReady }: { accountReady: boolean }) {
  const t = useTranslations("creatorStudio.payouts");
  const { toast } = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const [busy, setBusy] = useState(false);
  const handledReturn = useRef(false);

  const openStripe = useCallback(
    async (endpoint: "/api/stripe-connect/onboarding/start" | "/api/stripe-connect/login-link") => {
      setBusy(true);
      try {
        const res = await fetch(endpoint, { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (res.ok && body.url) {
          if (endpoint.endsWith("login-link")) window.open(body.url, "_blank", "noopener");
          else window.location.href = body.url;
          return;
        }
        toast({ title: body.error === "rate_limited" ? t("errors.rate_limited") : t("errors.connect"), tone: "danger" });
      } catch {
        toast({ title: t("errors.network"), tone: "danger" });
      } finally {
        setBusy(false);
      }
    },
    [t, toast],
  );

  useEffect(() => {
    if (handledReturn.current) return;
    if (search.get("success") === "1") {
      handledReturn.current = true;
      toast({ title: t("connectReturned"), tone: "success" });
      router.replace("/creator/payouts");
      router.refresh();
    } else if (search.get("refresh") === "1") {
      handledReturn.current = true;
      router.replace("/creator/payouts");
      void openStripe("/api/stripe-connect/onboarding/start");
    }
  }, [search, router, toast, t, openStripe]);

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0 space-y-1">
          <CardTitle>{t("connectTitle")}</CardTitle>
          <CardDescription>{accountReady ? t("connectReadyBody") : t("connectSetupBody")}</CardDescription>
        </div>
        {accountReady ? (
          <Badge tone="success" className="shrink-0">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {t("connectActive")}
          </Badge>
        ) : null}
      </CardHeader>
      {accountReady ? (
        <Button variant="secondary" loading={busy} onClick={() => openStripe("/api/stripe-connect/login-link")}>
          {t("connectDashboard")}
          <ExternalLink className="h-4 w-4" aria-hidden />
        </Button>
      ) : (
        <Button loading={busy} onClick={() => openStripe("/api/stripe-connect/onboarding/start")}>
          {t("connectSetup")}
        </Button>
      )}
    </Card>
  );
}
