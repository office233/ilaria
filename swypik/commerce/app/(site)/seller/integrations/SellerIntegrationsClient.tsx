"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  CheckCircle2,
  Plug,
  RefreshCw,
  ShoppingBag,
  Store,
  Trash2,
} from "lucide-react";
import type {
  CatalogConnectionSummary,
  CatalogProvider,
} from "@/lib/seller/imports/types";

type Props = {
  initialIntegrations: CatalogConnectionSummary[];
  shopifyResult:
    | { status: "connected" }
    | { status: "error"; code: string }
    | null;
};

type SyncSummary = {
  inspected: number;
  created: number;
  updated: number;
  failed: number;
};

type ImportResponse = {
  error?: string;
  result?: SyncSummary;
  nextCursor?: string | null;
};

const inputCls =
  "w-full rounded-control border border-subtle bg-surface px-3.5 py-2.5 text-sm font-semibold text-fg focus:outline-none focus:ring-2 focus:ring-brand";

const ERROR_KEYS: Record<string, string> = {
  invalid_shopify_store: "errors.invalidShopifyStore",
  shopify_credentials_missing: "errors.credentials",
  shopify_unauthorized: "errors.credentials",
  shopify_request_failed: "errors.provider",
  shopify_invalid_response: "errors.provider",
  shopify_customers_unavailable: "errors.provider",
  shopify_orders_unavailable: "errors.provider",
  shopify_api_version_missing: "errors.configuration",
  shopify_api_version_invalid: "errors.configuration",
  shopify_oauth_not_configured: "errors.configuration",
  oauth_not_configured: "errors.configuration",
  invalid_hmac: "errors.oauthSecurity",
  invalid_state: "errors.oauthSecurity",
  invalid_callback: "errors.oauthSecurity",
  missing_scopes: "errors.missingScopes",
  shopify_oauth_token_exchange_failed: "errors.credentials",
  shopify_oauth_token_invalid: "errors.credentials",
  shopify_reauthorization_required: "errors.reauthorize",
  woocommerce_credentials_missing: "errors.credentials",
  woocommerce_unauthorized: "errors.credentials",
  woocommerce_request_failed: "errors.provider",
  woocommerce_invalid_response: "errors.provider",
  woocommerce_customers_unavailable: "errors.provider",
  woocommerce_orders_unavailable: "errors.provider",
  external_store_already_connected: "errors.alreadyConnected",
  rate_limited: "errors.rateLimited",
  partial_sync_failure: "errors.partial",
  integration_disabled: "errors.disabled",
  validation_error: "errors.validation",
  server_error: "errors.generic",
};

function providerLabel(provider: CatalogProvider): string {
  return provider === "shopify" ? "Shopify" : "WooCommerce";
}

export default function SellerIntegrationsClient({
  initialIntegrations,
  shopifyResult,
}: Props) {
  const t = useTranslations("sellerPanel.integrations");
  const tNav = useTranslations("sellerPanel.nav");
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [shopifyStore, setShopifyStore] = useState("");
  const [wooUrl, setWooUrl] = useState("");
  const [wooKey, setWooKey] = useState("");
  const [wooSecret, setWooSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(
    shopifyResult?.status === "connected" ? t("oauthConnected") : null,
  );
  const [error, setError] = useState<string | null>(() => {
    if (shopifyResult?.status !== "error") return null;
    return t(ERROR_KEYS[shopifyResult.code] ?? "errors.generic");
  });

  const fail = (code: unknown) => {
    const key = typeof code === "string" ? ERROR_KEYS[code] : undefined;
    setError(t(key ?? "errors.generic"));
  };

  const connect = async (provider: CatalogProvider) => {
    setBusy(`connect:${provider}`);
    setMessage(null);
    setError(null);
    if (provider === "shopify") {
      const shop = shopifyStore.trim();
      if (!shop) {
        setBusy(null);
        fail("validation_error");
        return;
      }
      window.location.assign(
        `/api/seller/integrations/shopify/start?shop=${encodeURIComponent(shop)}`,
      );
      return;
    }
    try {
      const body = {
        provider,
        storeUrl: wooUrl,
        consumerKey: wooKey,
        consumerSecret: wooSecret,
      };
      const res = await fetch("/api/seller/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data?.error);

      const integration = data.integration as CatalogConnectionSummary;
      setIntegrations((current) => [
        integration,
        ...current.filter((item) => item.id !== integration.id),
      ]);
      setWooKey("");
      setWooSecret("");
      setMessage(t("connected", { provider: providerLabel(provider) }));
    } catch {
      fail("server_error");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (integration: CatalogConnectionSummary) => {
    setBusy(`delete:${integration.id}`);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/seller/integrations/${integration.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data?.error);
      setIntegrations((current) => current.filter((item) => item.id !== integration.id));
      setMessage(t("disconnected", { provider: providerLabel(integration.provider) }));
    } catch {
      fail("server_error");
    } finally {
      setBusy(null);
    }
  };

  const syncResource = async (
    integration: CatalogConnectionSummary,
    resource: "catalog" | "customers" | "orders",
  ) => {
    setBusy(`${resource}:${integration.id}`);
    setMessage(null);
    setError(null);
    const total: SyncSummary = { inspected: 0, created: 0, updated: 0, failed: 0 };
    let cursor: string | null | undefined = undefined;
    let completed = false;
    const suffix = resource === "catalog" ? "import" : resource;
    const label =
      resource === "customers"
        ? tNav("clients")
        : resource === "orders"
          ? tNav("orders")
          : null;

    try {
      // Keep a manual run bounded. The server persists each successful cursor,
      // so another click resumes safely for large stores.
      for (let batch = 0; batch < 50; batch += 1) {
        const res = await fetch(`/api/seller/integrations/${integration.id}/${suffix}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 50, ...(cursor !== undefined ? { cursor } : {}) }),
        });
        const data: ImportResponse = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 207) {
          fail(data?.error);
          return;
        }
        const result = data.result;
        if (!result) {
          fail("server_error");
          return;
        }
        total.inspected += result.inspected;
        total.created += result.created;
        total.updated += result.updated;
        total.failed += result.failed;
        if (result.failed > 0) {
          fail("partial_sync_failure");
          return;
        }
        cursor = data.nextCursor ?? null;
        if (!cursor) {
          completed = true;
          break;
        }
      }

      const summary = completed
          ? t("syncComplete", {
              inspected: total.inspected,
              created: total.created,
              updated: total.updated,
            })
          : t("syncPaused", {
              inspected: total.inspected,
              created: total.created,
              updated: total.updated,
            });
      setMessage(label ? `${label}: ${summary}` : summary);
      const list = await fetch("/api/seller/integrations").then((r) => r.json());
      if (Array.isArray(list?.integrations)) setIntegrations(list.integrations);
    } catch {
      fail("server_error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      <div className="border-b border-subtle pb-5">
        <h1 className="text-2xl font-black text-fg">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("subtitle")}</p>
      </div>

      {message ? (
        <div className="flex items-center gap-3 rounded-control border border-success/30 bg-success-soft p-4 text-sm font-medium text-success">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          {message}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-center gap-3 rounded-control border border-danger/30 bg-danger-soft p-4 text-sm font-medium text-danger">
          <AlertCircle className="h-5 w-5 shrink-0" />
          {error}
        </div>
      ) : null}

      <section className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-4 rounded-card border border-subtle bg-surface p-6 shadow-elev-1">
          <div className="flex items-center gap-3">
            <ShoppingBag className="h-5 w-5 text-brand" />
            <div>
              <h2 className="font-black text-fg">Shopify</h2>
              <p className="text-xs text-muted">{t("shopifyHint")}</p>
            </div>
          </div>
          <label className="block text-xs font-bold uppercase tracking-wider text-fg">
            {t("storeDomain")}
            <input
              className={`${inputCls} mt-1.5`}
              value={shopifyStore}
              onChange={(e) => setShopifyStore(e.target.value)}
              placeholder="store.myshopify.com"
              autoComplete="url"
            />
          </label>
          <p className="rounded-control border border-subtle bg-surface-2 p-3 text-xs leading-relaxed text-muted">
            {t("shopifyOAuthHint")}
          </p>
          <button
            type="button"
            disabled={!shopifyStore.trim() || busy !== null}
            onClick={() => void connect("shopify")}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-control bg-brand px-4 py-2.5 text-sm font-bold text-brand-fg disabled:opacity-50"
          >
            <Plug className="h-4 w-4" />
            {busy === "connect:shopify" ? t("connecting") : t("connectShopify")}
          </button>
        </div>

        <div className="space-y-4 rounded-card border border-subtle bg-surface p-6 shadow-elev-1">
          <div className="flex items-center gap-3">
            <Store className="h-5 w-5 text-brand" />
            <div>
              <h2 className="font-black text-fg">WooCommerce</h2>
              <p className="text-xs text-muted">{t("wooHint")}</p>
            </div>
          </div>
          <label className="block text-xs font-bold uppercase tracking-wider text-fg">
            {t("storeUrl")}
            <input
              className={`${inputCls} mt-1.5`}
              value={wooUrl}
              onChange={(e) => setWooUrl(e.target.value)}
              placeholder="https://shop.example.com"
              autoComplete="url"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-bold uppercase tracking-wider text-fg">
              {t("consumerKey")}
              <input
                className={`${inputCls} mt-1.5`}
                value={wooKey}
                onChange={(e) => setWooKey(e.target.value)}
                type="password"
                autoComplete="off"
              />
            </label>
            <label className="block text-xs font-bold uppercase tracking-wider text-fg">
              {t("consumerSecret")}
              <input
                className={`${inputCls} mt-1.5`}
                value={wooSecret}
                onChange={(e) => setWooSecret(e.target.value)}
                type="password"
                autoComplete="off"
              />
            </label>
          </div>
          <button
            type="button"
            disabled={!wooUrl.trim() || !wooKey.trim() || !wooSecret.trim() || busy !== null}
            onClick={() => void connect("woocommerce")}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-control bg-brand px-4 py-2.5 text-sm font-bold text-brand-fg disabled:opacity-50"
          >
            <Plug className="h-4 w-4" />
            {busy === "connect:woocommerce" ? t("connecting") : t("connect")}
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-black text-fg">{t("connectedStores")}</h2>
          <p className="text-sm text-muted">{t("connectedStoresHint")}</p>
        </div>

        {integrations.length === 0 ? (
          <div className="rounded-card border border-dashed border-subtle bg-surface p-8 text-center text-sm text-muted">
            {t("empty")}
          </div>
        ) : (
          integrations.map((integration) => (
            <article
              key={integration.id}
              className="flex flex-col gap-4 rounded-card border border-subtle bg-surface p-5 shadow-elev-1 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="text-fg">{providerLabel(integration.provider)}</strong>
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-bold text-muted">
                    {t(`status.${integration.status}`)}
                  </span>
                </div>
                <p className="truncate text-sm font-semibold text-muted">
                  {integration.externalAccountId}
                </p>
                <p className="mt-1 text-xs text-subtle">
                  {t("autoSync")}: {t(`autoSyncStatus.${integration.webhookStatus}`)}
                </p>
                <p className="mt-1 text-xs text-subtle">
                  {integration.lastSyncAt
                    ? t("lastSync", {
                        date: new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(integration.lastSyncAt)),
                      })
                    : t("neverSynced")}
                </p>
                <p className="mt-1 text-xs text-subtle">
                  {tNav("clients")}:{" "}
                  {integration.lastCustomerSyncAt
                    ? t("lastSync", {
                        date: new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(integration.lastCustomerSyncAt)),
                      })
                    : t("neverSynced")}
                </p>
                <p className="mt-1 text-xs text-subtle">
                  {tNav("orders")}:{" "}
                  {integration.lastOrderSyncAt
                    ? t("lastSync", {
                        date: new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(integration.lastOrderSyncAt)),
                      })
                    : t("neverSynced")}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void syncResource(integration, "catalog")}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-control bg-fg px-3.5 py-2 text-sm font-bold text-fg-inverse disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${busy === `catalog:${integration.id}` ? "animate-spin" : ""}`}
                  />
                  {busy === `catalog:${integration.id}` ? t("syncing") : t("sync")}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void syncResource(integration, "customers")}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-control border border-subtle bg-surface-2 px-3.5 py-2 text-sm font-bold text-fg disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${busy === `customers:${integration.id}` ? "animate-spin" : ""}`}
                  />
                  {busy === `customers:${integration.id}`
                    ? t("syncing")
                    : `${t("sync")} · ${tNav("clients")}`}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void syncResource(integration, "orders")}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-control border border-subtle bg-surface-2 px-3.5 py-2 text-sm font-bold text-fg disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${busy === `orders:${integration.id}` ? "animate-spin" : ""}`}
                  />
                  {busy === `orders:${integration.id}`
                    ? t("syncing")
                    : `${t("sync")} · ${tNav("orders")}`}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void disconnect(integration)}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-control border border-danger/30 px-3.5 py-2 text-sm font-bold text-danger disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("disconnect")}
                </button>
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
