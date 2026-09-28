"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { Clapperboard, Film, Check, X } from "lucide-react";

/* ─── Types ─── */

interface VideoAsset {
  id: string;
  status: string;
  raw_key: string | null;
  mp4_key: string | null;
  thumbnail_key: string | null;
  thumbnail_url?: string | null;
  hls_master_key: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  error_message: string | null;
  created_at: string;
  creator_name: string | null;
  creator_email: string | null;
  product_title: string | null;
  product_id: string | null;
  job_status: string | null;
  job_attempts: number | null;
}

/* ─── Constants ─── */

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  pending: { bg: "rgba(245,158,11,0.15)", text: "#F59E0B", border: "rgba(245,158,11,0.3)" },
  processing: { bg: "rgba(59,130,246,0.15)", text: "#3B82F6", border: "rgba(59,130,246,0.3)" },
  ready: { bg: "rgba(16,163,127,0.15)", text: "#0D0D0D", border: "rgba(16,163,127,0.3)" },
  failed: { bg: "rgba(239,68,68,0.15)", text: "#EF4444", border: "rgba(239,68,68,0.3)" },
  queued: { bg: "rgba(13,13,13,0.15)", text: "#0D0D0D", border: "rgba(13,13,13,0.15)" },
};

function getStatusStyle(status: string) {
  return STATUS_COLORS[status] || STATUS_COLORS.pending;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDimensions(w: number | null, h: number | null): string {
  if (!w || !h) return "—";
  return `${w}×${h}`;
}

/* ─── Main Page ─── */

const PAGE_SIZE = 50;

export default function AdminVideosPage() {
  const t = useTranslations("adminVideos");
  const locale = useLocale();
  const STATUS_FILTER_OPTIONS = [
    { value: "all", label: t("statusAll") },
    { value: "pending", label: t("statusPending") },
    { value: "processing", label: t("statusProcessing") },
    { value: "ready", label: t("statusReady") },
    { value: "failed", label: t("statusFailed") },
  ];
  const STATUS_LABEL_MAP: Record<string, string> = {
    pending: t("statusPending"),
    processing: t("statusProcessing"),
    ready: t("statusReady"),
    failed: t("statusFailed"),
    queued: t("statusQueued"),
  };
  const [videos, setVideos] = useState<VideoAsset[]>([]);
  const [counts, setCounts] = useState({ total: 0, ready: 0, processing: 0, failed: 0, pending: 0 });
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  /* ─── Fetch (server-side filter + pagination) ─── */
  const fetchVideos = useCallback(async () => {
    setLoading(true);
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
        status: statusFilter,
      });
      const res = await fetch(`/api/admin/videos?${params.toString()}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(t("loadFailed"));
      const data = await res.json();
      setVideos(data.videos ?? []);
      setCounts(data.totals ?? { total: 0, ready: 0, processing: 0, failed: 0, pending: 0 });
      setFilteredTotal(Number(data.filteredTotal) || 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, t]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  /* Reset to page 1 when filter changes */
  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  /* ─── Actions ─── */
  const performAction = async (action: string, videoId: string, reason?: string) => {
    setActionLoading(videoId);
    try {
      const res = await fetch("/api/admin/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action, videoId, reason }),
      });
      if (!res.ok) throw new Error(t("actionFailed"));
      await fetchVideos();
    } catch {
      alert(t("actionFailedRetry"));
    } finally {
      setActionLoading(null);
      setRejectId(null);
      setRejectReason("");
    }
  };

  /* server returns already-filtered list */
  const filtered = videos;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  return (
    <div className="min-h-screen bg-white text-[#0D0D0D]" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* ─── Header ─── */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-black flex items-center gap-3">
              <Clapperboard size={28} /> {t("pageTitle")}
            </h1>
            <p className="mt-1 text-sm text-[#6E6E80]">
              {t("pageSubtitle")}
            </p>
          </div>
          <Link
            href="/admin"
            className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-[#0D0D0D] border border-[#E5E5E7] hover:border-[#0D0D0D] transition-colors"
          >
            &larr; {t("backToDashboard")}
          </Link>
        </div>

        {/* ─── Summary badges ─── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatBadge label={t("statTotal")} value={counts.total} color="#6E6E80" loading={loading} />
          <StatBadge label={t("statProcessing")} value={counts.processing} color="#3B82F6" loading={loading} />
          <StatBadge label={t("statReady")} value={counts.ready} color="#0D0D0D" loading={loading} />
          <StatBadge label={t("statFailed")} value={counts.failed} color="#EF4444" loading={loading} />
        </div>

        {/* ─── Filter bar ─── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-bold text-[#6E6E80] uppercase tracking-wider">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            {t("filters")}
          </div>
          <select
            id="video-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-xl bg-white border border-[#E5E5E7] px-4 py-2.5 text-sm font-bold text-[#0D0D0D] focus:border-[#0D0D0D] focus:outline-none focus:ring-2 focus:ring-[#0D0D0D]/20 transition-all cursor-pointer appearance-none"
            style={{
              backgroundImage:
                'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\'%3E%3Cpath fill=\'%236E6E80\' d=\'M6 8.825a.5.5 0 01-.354-.146l-3-3a.5.5 0 11.708-.708L6 7.621l2.646-2.647a.5.5 0 11.708.708l-3 3A.5.5 0 016 8.825z\'/%3E%3C/svg%3E")',
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 12px center",
              paddingRight: "36px",
            }}
          >
            {STATUS_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t("statusColon")} {o.label}
              </option>
            ))}
          </select>
          <div className="ml-auto text-sm text-[#6E6E80] tabular-nums">
            {t("videosFound", { count: filtered.length })}
          </div>
        </div>

        {/* ─── Error ─── */}
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-400">
            {error}
          </div>
        )}

        {/* ─── Table ─── */}
        <div className="rounded-2xl border border-[#E5E5E7] bg-white overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-[#E5E5E7] bg-[#F7F7F8] text-[10px] font-black uppercase tracking-widest text-[#6E6E80]">
                  <th className="text-left px-5 py-4">{t("thThumbnail")}</th>
                  <th className="text-left px-5 py-4">{t("thCreator")}</th>
                  <th className="text-left px-5 py-4">{t("thProduct")}</th>
                  <th className="text-center px-5 py-4">{t("thStatus")}</th>
                  <th className="text-center px-5 py-4">{t("thDuration")}</th>
                  <th className="text-center px-5 py-4">{t("thDimensions")}</th>
                  <th className="text-left px-5 py-4">{t("thDate")}</th>
                  <th className="text-right px-5 py-4">{t("thActions")}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-20 text-center">
                      <div className="inline-flex items-center gap-3 text-[#6E6E80]">
                        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        {t("loadingVideos")}
                      </div>
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-20 text-center text-[#6E6E80]">
                      {videos.length === 0
                        ? t("noVideosYet")
                        : t("noVideosMatchFilter")}
                    </td>
                  </tr>
                ) : (
                  filtered.map((video, idx) => {
                    const isEven = idx % 2 === 0;
                    const statusStyle = getStatusStyle(video.status);
                    const isActionTarget = actionLoading === video.id;

                    return (
                      <tr
                        key={video.id}
                        className="border-b border-[#F0F0F2] hover:bg-[#F7F7F8] transition-colors"
                        style={{ backgroundColor: isEven ? "transparent" : "rgba(0,0,0,0.015)" }}
                      >
                        {/* Thumbnail */}
                        <td className="px-5 py-3">
                          <div className="w-16 h-10 rounded-lg overflow-hidden bg-[#0D0D0D] border border-[#E5E5E7] flex items-center justify-center">
                            {video.thumbnail_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={video.thumbnail_url}
                                alt={t("thumbnailAlt")}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = "none";
                                }}
                              />
                            ) : (
                              <Film size={20} className="text-[#444]" />
                            )}
                          </div>
                        </td>

                        {/* Creator */}
                        <td className="px-5 py-3">
                          <p className="font-semibold text-[#0D0D0D] truncate max-w-[160px]">
                            {video.creator_name || t("unknown")}
                          </p>
                          <p className="text-[10px] text-[#6E6E80] truncate max-w-[160px]">
                            {video.creator_email || "—"}
                          </p>
                        </td>

                        {/* Product */}
                        <td className="px-5 py-3">
                          {video.product_title ? (
                            <Link
                              href={`/admin/marketplace/${video.product_id}`}
                              className="font-semibold text-[#0D0D0D] hover:underline truncate block max-w-[200px]"
                            >
                              {video.product_title}
                            </Link>
                          ) : (
                            <span className="text-[#6E6E80]">{t("noProduct")}</span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="px-5 py-3 text-center">
                          <span
                            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-wider"
                            style={{
                              backgroundColor: statusStyle.bg,
                              color: statusStyle.text,
                              border: `1px solid ${statusStyle.border}`,
                            }}
                          >
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: statusStyle.text }}
                            />
                            {STATUS_LABEL_MAP[video.status] || video.status}
                          </span>
                          {video.job_status && video.job_status !== video.status && (
                            <p className="text-[9px] text-[#6E6E80] mt-1">
                              {t("jobLabel")}: {video.job_status}
                              {video.job_attempts ? ` (×${video.job_attempts})` : ""}
                            </p>
                          )}
                          {video.error_message && (
                            <p className="text-[9px] text-red-400 mt-1 max-w-[140px] truncate" title={video.error_message}>
                              {video.error_message}
                            </p>
                          )}
                        </td>

                        {/* Duration */}
                        <td className="px-5 py-3 text-center font-mono text-[#6E6E80]">
                          {formatDuration(video.duration_seconds)}
                        </td>

                        {/* Dimensions */}
                        <td className="px-5 py-3 text-center font-mono text-[#6E6E80] text-xs">
                          {formatDimensions(video.width, video.height)}
                        </td>

                        {/* Date */}
                        <td className="px-5 py-3 text-xs text-[#6E6E80]">
                          {new Intl.DateTimeFormat(locale, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          }).format(new Date(video.created_at))}
                          <br />
                          <span className="text-[10px]">
                            {new Intl.DateTimeFormat(locale, {
                              hour: "2-digit",
                              minute: "2-digit",
                            }).format(new Date(video.created_at))}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-2">
                            {isActionTarget ? (
                              <span className="text-[#6E6E80] text-xs animate-pulse">{t("processingEllipsis")}</span>
                            ) : (
                              <>
                                {/* Approve — only if NOT ready */}
                                {video.status !== "ready" && (
                                  <button
                                    onClick={() => performAction("approve", video.id)}
                                    className="rounded-lg bg-[#0D0D0D]/15 px-3 py-1.5 text-[11px] font-bold text-[#0D0D0D] border border-[#0D0D0D]/30 hover:bg-[#0D0D0D]/25 hover:border-[#0D0D0D]/50 transition-all"
                                  >
                                    <span className="inline-flex items-center gap-1"><Check size={12} /> {t("approve")}</span>
                                  </button>
                                )}

                                {/* Reject — opens reason input */}
                                {rejectId === video.id ? (
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="text"
                                      placeholder={t("reasonPlaceholder")}
                                      value={rejectReason}
                                      onChange={(e) => setRejectReason(e.target.value)}
                                      className="w-28 rounded-lg bg-white border border-[#E5E5E7] px-2 py-1 text-[11px] text-[#0D0D0D] placeholder:text-[#9CA3AF] focus:outline-none focus:border-red-500"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          performAction("reject", video.id, rejectReason);
                                        } else if (e.key === "Escape") {
                                          setRejectId(null);
                                          setRejectReason("");
                                        }
                                      }}
                                    />
                                    <button
                                      onClick={() => performAction("reject", video.id, rejectReason)}
                                      className="rounded-lg bg-red-50 px-2 py-1 text-[11px] font-bold text-red-600 border border-red-200 hover:bg-red-100 transition-all"
                                    >
                                      {t("ok")}
                                    </button>
                                    <button
                                      onClick={() => {
                                        setRejectId(null);
                                        setRejectReason("");
                                      }}
                                      className="text-[#6E6E80] text-[11px] hover:text-[#0D0D0D] transition-colors px-1"
                                    >
                                      <X size={12} />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setRejectId(video.id)}
                                    className="rounded-lg bg-red-50 px-3 py-1.5 text-[11px] font-bold text-red-600 border border-red-200 hover:bg-red-100 hover:border-red-300 transition-all"
                                  >
                                    <span className="inline-flex items-center gap-1"><X size={12} /> {t("reject")}</span>
                                  </button>
                                )}

                                {/* Reprocess — only if failed */}
                                {video.status === "failed" && (
                                  <button
                                    onClick={() => performAction("reprocess", video.id)}
                                    className="rounded-lg bg-[#F59E0B]/10 px-3 py-1.5 text-[11px] font-bold text-[#F59E0B] border border-[#F59E0B]/20 hover:bg-[#F59E0B]/20 hover:border-[#F59E0B]/40 transition-all"
                                  >
                                    &#8635; {t("reprocess")}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {filteredTotal > PAGE_SIZE && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-[#E5E5E7] bg-[#F7F7F8] px-5 py-4">
              <div className="text-sm text-[#6E6E80] tabular-nums">
                {t("pageOf", { page: safePage, totalPages })} &middot; {t("videosFound", { count: filteredTotal })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#E5E5E7] bg-white px-4 py-2.5 text-sm font-bold text-[#0D0D0D] disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px]"
                >
                  &larr; {t("previous")}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[#E5E5E7] bg-white px-4 py-2.5 text-sm font-bold text-[#0D0D0D] disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px]"
                >
                  {t("next")} &rarr;
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/* ─── Sub-components ─── */

function StatBadge({
  label,
  value,
  color,
  loading,
}: {
  label: string;
  value: number;
  color: string;
  loading?: boolean;
}) {
  return (
    <div
      className="rounded-2xl bg-white border border-[#E5E5E7] p-5 hover:shadow-md transition-all shadow-sm"
      style={{ borderLeftColor: color, borderLeftWidth: "3px" }}
    >
      <p className="text-xs font-black uppercase tracking-widest text-[#6E6E80] mb-1">
        {label}
      </p>
      {loading ? (
        <div className="h-8 w-12 animate-pulse rounded-lg bg-[#E5E5E7]" />
      ) : (
        <p className="text-2xl font-black" style={{ color: color === "#0D0D0D" ? "#0D0D0D" : color }}>
          {value}
        </p>
      )}
    </div>
  );
}
