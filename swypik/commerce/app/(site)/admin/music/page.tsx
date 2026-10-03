"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { musicGenreLabelKey, type MusicGenre } from "@/lib/music/genres";
import type { ContentStatus, MusicArtistRow, MusicTrackRow } from "@/lib/music/types";

type Tab = "artists" | "tracks";
type AdminArtist = MusicArtistRow & { display_name: string | null; email: string | null; track_count: number };
type AdminTrack = MusicTrackRow & { artist: MusicArtistRow };

const STATUSES: ContentStatus[] = ["pending_review", "draft", "published", "archived"];
const REQUEST_OPTS: RequestInit = { credentials: "same-origin", headers: { "Content-Type": "application/json" } };

type StatusKey = "statusDraft" | "statusPendingReview" | "statusPublished" | "statusArchived";
const STATUS_KEY: Record<ContentStatus, StatusKey> = {
  draft: "statusDraft",
  pending_review: "statusPendingReview",
  published: "statusPublished",
  archived: "statusArchived",
};

export default function AdminMusicPage() {
  const t = useTranslations("music");
  const formatPrice = useFormatPrice();
  const [tab, setTab] = useState<Tab>("artists");
  const [artists, setArtists] = useState<AdminArtist[]>([]);
  const [status, setStatus] = useState<ContentStatus>("pending_review");
  const [tracks, setTracks] = useState<AdminTrack[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [newArtist, setNewArtist] = useState({ userId: "", stageName: "", bio: "" });
  const [preview, setPreview] = useState<{ trackId: string; url: string } | null>(null);

  const loadArtists = useCallback(() => {
    fetch("/api/admin/music/artists", REQUEST_OPTS)
      .then((r) => r.json())
      .then((d) => setArtists(d.artists ?? []))
      .catch(() => setMsg(t("loadError")));
  }, [t]);
  const loadTracks = useCallback(() => {
    fetch(`/api/admin/music/tracks?status=${status}`, REQUEST_OPTS)
      .then((r) => r.json())
      .then((d) => setTracks(d.tracks ?? []))
      .catch(() => setMsg(t("loadError")));
  }, [status, t]);

  useEffect(loadArtists, [loadArtists]);
  useEffect(loadTracks, [loadTracks]);

  const approveArtist = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const res = await fetch("/api/admin/music/artists", { ...REQUEST_OPTS, method: "POST", body: JSON.stringify(newArtist) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(`${t("error")} ${d.error ?? ""}`.trim());
      return;
    }
    setNewArtist({ userId: "", stageName: "", bio: "" });
    loadArtists();
  };

  const removeArtist = async (userId: string) => {
    if (!window.confirm(t("remove"))) return;
    const res = await fetch("/api/admin/music/artists", { ...REQUEST_OPTS, method: "DELETE", body: JSON.stringify({ userId }) });
    if (!res.ok) {
      setMsg(t("error"));
      return;
    }
    loadArtists();
  };

  const patchTrack = async (id: string, action: "approve" | "reject" | "publish" | "archive") => {
    setMsg(null);
    const res = await fetch(`/api/admin/music/tracks/${id}`, { ...REQUEST_OPTS, method: "PATCH", body: JSON.stringify({ action }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(`${t("error")} ${d.error ?? ""}`.trim());
      return;
    }
    loadTracks();
  };

  const loadPreview = async (track: AdminTrack) => {
    setPreview(null);
    const res = await fetch(`/api/music/tracks/${track.slug}/play`, REQUEST_OPTS);
    const d = await res.json().catch(() => ({}));
    if (res.ok && typeof d.url === "string") setPreview({ trackId: track.id, url: d.url });
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-black">{t("admin")}</h1>
      {msg && <p className="text-sm font-semibold">{msg}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={() => setTab("artists")} className={`rounded-full px-3 py-1 text-xs font-bold ${tab === "artists" ? "bg-black text-white" : "bg-neutral-100"}`}>
          {t("artists")}
        </button>
        <button type="button" onClick={() => setTab("tracks")} className={`rounded-full px-3 py-1 text-xs font-bold ${tab === "tracks" ? "bg-black text-white" : "bg-neutral-100"}`}>
          {t("tracks")}
        </button>
      </div>

      {tab === "artists" && (
        <>
          <p className="text-sm text-neutral-600">{t("artistsIntro")}</p>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th>{t("stageName")}</th><th>{t("trackCount")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {artists.map((a) => (
                <tr key={a.user_id} className="border-t">
                  <td className="py-2 font-bold">
                    {a.stage_name}
                    <div className="text-xs font-normal text-neutral-500">{a.display_name ?? a.email ?? a.user_id.slice(0, 8)}</div>
                  </td>
                  <td>{a.track_count}</td>
                  <td className="text-right">
                    <button type="button" onClick={() => removeArtist(a.user_id)} className="rounded-lg bg-red-600 px-2 py-1 text-xs font-bold text-white">
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <section className="rounded-2xl border border-[#E5E5E5] p-4">
            <h2 className="mb-2 font-black">{t("approveArtist")}</h2>
            <form onSubmit={approveArtist} className="grid gap-2 sm:grid-cols-3">
              <input
                required
                value={newArtist.userId}
                onChange={(e) => setNewArtist({ ...newArtist, userId: e.target.value })}
                placeholder={t("userIdPlaceholder")}
                className="rounded-xl border border-[#E5E5E5] px-3 py-2 text-sm"
              />
              <input
                required
                value={newArtist.stageName}
                onChange={(e) => setNewArtist({ ...newArtist, stageName: e.target.value })}
                placeholder={t("stageName")}
                className="rounded-xl border border-[#E5E5E5] px-3 py-2 text-sm"
              />
              <input
                value={newArtist.bio}
                onChange={(e) => setNewArtist({ ...newArtist, bio: e.target.value })}
                placeholder={t("bio")}
                className="rounded-xl border border-[#E5E5E5] px-3 py-2 text-sm"
              />
              <button type="submit" className="rounded-xl bg-black px-4 py-2 text-sm font-bold text-white sm:col-span-3">
                {t("approveArtist")}
              </button>
            </form>
          </section>
        </>
      )}

      {tab === "tracks" && (
        <>
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={`rounded-full px-3 py-1 text-xs font-bold ${status === s ? "bg-black text-white" : "bg-neutral-100"}`}
              >
                {t(STATUS_KEY[s])}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th>{t("trackTitle")}</th><th>{t("artists")}</th><th>{t("priceLabel")}</th><th>{t("review")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((tr) => (
                <tr key={tr.id} className="border-t align-top">
                  <td className="py-2 font-bold">
                    {tr.title}
                    <div className="text-xs font-normal text-neutral-500">
                      <span className="sr-only">{t("genre")}: </span>
                      {t(musicGenreLabelKey(tr.genre as MusicGenre))}
                      {tr.is_premium && <> · {t("premium")}</>}
                      {tr.explicit && <> · {t("explicitBadge")}</>}
                      {tr.audience === "kids" && <> · {t("audienceKids")}</>}
                    </div>
                    {preview?.trackId === tr.id ? (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <audio controls src={preview.url} className="mt-1 h-8 w-full max-w-xs" />
                    ) : (
                      <button type="button" onClick={() => loadPreview(tr)} className="mt-1 text-xs font-bold underline">
                        {t("play")}
                      </button>
                    )}
                  </td>
                  <td>{tr.artist.stage_name}</td>
                  <td>{tr.is_premium ? (tr.price_cents !== null ? formatPrice(tr.price_cents, { sourceCurrency: "RON" }) : t("priceComingSoon")) : "—"}</td>
                  <td>{t(STATUS_KEY[tr.status])}</td>
                  <td className="space-x-1 whitespace-nowrap text-right">
                    {tr.moderation_status !== "approved" && (
                      <button type="button" onClick={() => patchTrack(tr.id, "approve")} className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-bold text-white">
                        {t("approve")}
                      </button>
                    )}
                    {tr.moderation_status !== "rejected" && (
                      <button type="button" onClick={() => patchTrack(tr.id, "reject")} className="rounded-lg bg-red-600 px-2 py-1 text-xs font-bold text-white">
                        {t("reject")}
                      </button>
                    )}
                    {tr.status !== "published" && (
                      <button type="button" onClick={() => patchTrack(tr.id, "publish")} className="rounded-lg bg-black px-2 py-1 text-xs font-bold text-white">
                        {t("publish")}
                      </button>
                    )}
                    {tr.status !== "archived" && (
                      <button type="button" onClick={() => patchTrack(tr.id, "archive")} className="rounded-lg bg-neutral-800 px-2 py-1 text-xs font-bold text-white">
                        {t("archive")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </div>
  );
}
