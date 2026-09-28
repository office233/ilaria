"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  ListChecks,
  Server,
  XCircle,
} from "lucide-react";
import type { HealthResult } from "@/lib/health";

type CardKey = "db" | "redis" | "r2" | "queue";

const ENDPOINTS: Record<CardKey, string> = {
  db: "/api/health/db",
  redis: "/api/health/redis",
  r2: "/api/health/r2",
  queue: "/api/health/queue",
};

const ICONS: Record<CardKey, typeof Database> = {
  db: Database,
  redis: Server,
  r2: HardDrive,
  queue: ListChecks,
};

type Meta = Record<CardKey, { title: string; desc: string }>;

interface Props {
  initial: Record<CardKey, HealthResult>;
  checkedAt: string;
  meta: Meta;
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("adminHealth");
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded">
        <CheckCircle2 className="w-3.5 h-3.5" /> {t("statusOk")}
      </span>
    );
  }
  if (status === "degraded") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
        <AlertTriangle className="w-3.5 h-3.5" /> {t("statusDegraded")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded">
      <XCircle className="w-3.5 h-3.5" /> {t("statusError")}
    </span>
  );
}

function formatDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail);
  if (entries.length === 0) return "—";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export default function HealthRefresh({ initial, checkedAt, meta }: Props) {
  const t = useTranslations("adminHealth");
  const locale = useLocale();
  const [results, setResults] = useState<Record<CardKey, HealthResult>>(initial);
  const [lastCheck, setLastCheck] = useState<string>(checkedAt);
  const [refreshing, setRefreshing] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function refresh() {
    setRefreshing(true);
    const keys: CardKey[] = ["db", "redis", "r2", "queue"];
    const next: Record<CardKey, HealthResult> = { ...results };
    await Promise.all(
      keys.map(async (k) => {
        try {
          const res = await fetch(ENDPOINTS[k], { cache: "no-store" });
          const json = (await res.json()) as HealthResult;
          next[k] = json;
        } catch (err) {
          next[k] = {
            status: "error",
            latency_ms: 0,
            detail: { error: (err as Error).message },
          };
        }
      }),
    );
    setResults(next);
    setLastCheck(new Date().toISOString());
    setRefreshing(false);
  }

  useEffect(() => {
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keys: CardKey[] = ["db", "redis", "r2", "queue"];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="text-xs text-[#0D0D0D]/60 inline-flex items-center gap-1.5" suppressHydrationWarning>
          <Activity className="w-3.5 h-3.5 shrink-0" />
          {t("lastCheck")}: {mounted ? new Date(lastCheck).toLocaleTimeString(locale) : "—"}
          {refreshing && <span className="text-amber-700">· {t("refreshing")}</span>}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="text-xs font-bold bg-[#0D0D0D] text-white px-3 py-1.5 rounded-md disabled:opacity-50"
        >
          {t("refreshNow")}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {keys.map((k) => {
          const r = results[k];
          const Icon = ICONS[k];
          return (
            <div
              key={k}
              className="bg-white border border-[#0D0D0D]/10 rounded-lg p-4 shadow-sm"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className="w-5 h-5 text-[#0D0D0D]" />
                  <h2 className="font-black text-[#0D0D0D]">{meta[k].title}</h2>
                </div>
                <StatusBadge status={r.status} />
              </div>
              <p className="text-xs text-[#0D0D0D]/60 mb-3">{meta[k].desc}</p>
              <dl className="text-xs space-y-1">
                <div className="flex justify-between">
                  <dt className="text-[#0D0D0D]/60">{t("latency")}</dt>
                  <dd className="font-bold text-[#0D0D0D]">{r.latency_ms} ms</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#0D0D0D]/60 shrink-0">{t("details")}</dt>
                  <dd className="font-mono text-[10px] text-[#0D0D0D]/80 text-right break-all">
                    {formatDetail(r.detail)}
                  </dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
    </div>
  );
}
