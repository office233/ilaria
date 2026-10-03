"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, Play, XCircle } from "lucide-react";
import type { CronJob } from "./jobs";

interface LastRun {
  job_name: string;
  started_at: string;
  completed_at: string | null;
  status: string | null;
  duration_ms: number | null;
  error: string | null;
}

interface Props {
  job: CronJob;
  last: LastRun | null;
}

function fmtAgo(iso: string, locale: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return rtf.format(0, "minute");
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  return rtf.format(-Math.floor(h / 24), "day");
}

export default function CronJobRow({ job, last }: Props) {
  const t = useTranslations("adminCron");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function trigger() {
    setBusy(true);
    setToast(null);
    try {
      const res = await fetch("/api/admin/cron/" + job.name + "/trigger", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setToast({ type: "ok", msg: t("jobStarted") });
      } else {
        setToast({ type: "err", msg: data.error || t("httpError", { status: res.status }) });
      }
    } catch (err) {
      setToast({ type: "err", msg: (err as Error).message });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  return (
    <tr className="border-t border-[#0D0D0D]/5">
      <td className="px-4 py-3">
        <div className="font-bold text-[#0D0D0D]">{job.name}</div>
        <div className="text-xs text-[#0D0D0D]/60 mt-0.5">{t(job.descriptionKey)}</div>
        <code className="text-[10px] text-[#0D0D0D]/40">{job.endpoint}</code>
      </td>
      <td className="px-4 py-3 text-xs text-[#0D0D0D]/70">{t(job.scheduleKey)}</td>
      <td className="px-4 py-3 text-xs text-[#0D0D0D]/70" suppressHydrationWarning>
        {last ? (
          <>
            {mounted ? fmtAgo(last.started_at, locale) : "—"}
            {last.duration_ms != null && (
              <span className="text-[#0D0D0D]/40"> · {last.duration_ms}ms</span>
            )}
          </>
        ) : (
          <span className="text-[#0D0D0D]/40">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {last?.status === "success" && (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
            <CheckCircle2 className="w-3.5 h-3.5" /> {t("statusSuccess")}
          </span>
        )}
        {last?.status === "failed" && (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700" title={last.error || ""}>
            <XCircle className="w-3.5 h-3.5" /> {t("statusFailed")}
          </span>
        )}
        {last?.status === "running" && (
          <span className="text-xs font-bold text-amber-700">{t("statusRunning")}</span>
        )}
        {!last && <span className="text-xs text-[#0D0D0D]/40">{t("statusUnknown")}</span>}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={trigger}
          disabled={busy}
          className={"inline-flex items-center gap-1 text-xs font-bold bg-[#0D0D0D] text-white px-3 py-1.5 rounded-md disabled:opacity-50"}
        >
          <Play className="w-3.5 h-3.5" />
          {busy ? t("starting") : t("runNow")}
        </button>
        {toast && (
          <div className={"text-[10px] mt-1 " + (toast.type === "ok" ? "text-emerald-700" : "text-red-700")}>
            {toast.msg}
          </div>
        )}
      </td>
    </tr>
  );
}
