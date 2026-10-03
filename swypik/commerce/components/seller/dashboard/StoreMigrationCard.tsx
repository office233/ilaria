"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Plug, Store } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type AutoSyncStatus = "pending" | "active" | "degraded" | "unavailable" | null;

export function StoreMigrationCard({
  connected,
  autoSyncStatus,
}: {
  connected: number;
  autoSyncStatus: AutoSyncStatus;
}) {
  const t = useTranslations("sellerPanel.dashboard");
  const ti = useTranslations("sellerPanel.integrations");
  const searchParams = useSearchParams();
  const [shop, setShop] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const oauthState = searchParams.get("shopify");
  const oauthCode = searchParams.get("code");
  const oauthErrorKey =
    oauthCode === "oauth_not_configured" || oauthCode === "shopify_oauth_not_configured"
      ? "errors.configuration"
      : oauthCode === "invalid_hmac" || oauthCode === "invalid_state" || oauthCode === "invalid_callback"
        ? "errors.oauthSecurity"
        : oauthCode === "missing_scopes"
          ? "errors.missingScopes"
          : oauthCode === "shopify_reauthorization_required"
            ? "errors.reauthorize"
            : oauthCode === "rate_limited"
              ? "errors.rateLimited"
              : "errors.generic";

  const connectShopify = () => {
    const value = shop.trim();
    if (!value || redirecting) return;
    setRedirecting(true);
    window.location.assign(
      `/api/seller/integrations/shopify/start?shop=${encodeURIComponent(value)}`,
    );
  };

  if (connected > 0) {
    return (
      <Card padding="md">
        {oauthState === "connected" ? (
          <div className="mb-3 flex items-start gap-2 rounded-control bg-success-soft p-3 text-sm font-semibold text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{ti("oauthConnected")}</span>
          </div>
        ) : null}
        {oauthState === "error" ? (
          <div className="mb-3 flex items-start gap-2 rounded-control bg-danger-soft p-3 text-sm font-semibold text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{ti(oauthErrorKey)}</span>
          </div>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="rounded-control bg-surface-2 p-2 text-brand">
              <Store className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <p className="font-black text-fg">{t("importStoreTitle")}</p>
              <p className="mt-1 text-sm text-muted">
                {t("connectedStoresCount", { count: connected })}
                {autoSyncStatus ? ` · ${ti(`autoSyncStatus.${autoSyncStatus}`)}` : null}
              </p>
            </div>
          </div>
          <Button asChild size="sm">
            <Link href="/seller/integrations">{t("manageIntegrations")}</Link>
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card padding="md">
      {oauthState === "error" ? (
        <div className="mb-3 flex items-start gap-2 rounded-control bg-danger-soft p-3 text-sm font-semibold text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{ti(oauthErrorKey)}</span>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-end">
        <div>
          <div className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-brand" aria-hidden />
            <p className="font-black text-fg">{t("importStoreTitle")}</p>
          </div>
          <p className="mt-1 text-sm text-muted">{t("importStoreHint")}</p>
          <Link
            href="/seller/integrations"
            className="mt-2 inline-flex min-h-10 items-center text-sm font-semibold text-brand"
          >
            {t("otherIntegrations")}
          </Link>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="min-w-0 flex-1">
            <span className="sr-only">{ti("storeDomain")}</span>
            <input
              value={shop}
              onChange={(event) => setShop(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") connectShopify();
              }}
              placeholder="store.myshopify.com"
              autoComplete="url"
              className="min-h-11 w-full rounded-control border border-subtle bg-surface px-3.5 text-sm font-semibold text-fg outline-none focus:ring-2 focus:ring-brand"
            />
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!shop.trim() || redirecting}
            onClick={connectShopify}
            className="min-h-11 whitespace-nowrap"
          >
            {redirecting ? ti("connecting") : ti("connectShopify")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
