"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Headphones, Music, Plus, UploadCloud } from "lucide-react";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import {
  MUSIC_ALLOWED_MIME,
  MUSIC_DEFAULT_TRACK_PRICE_CENTS,
  MUSIC_MAX_DURATION_MS,
  MUSIC_MAX_UPLOAD_BYTES,
  MUSIC_MIN_DURATION_MS,
  MUSIC_TRACK_PRICE_MAX_CENTS,
  MUSIC_TRACK_PRICE_MIN_CENTS,
} from "@/lib/music/config";
import { MUSIC_GENRES, musicGenreLabelKey, type MusicGenre } from "@/lib/music/genres";
import type { ContentStatus, MusicArtistRow, MusicAudience } from "@/lib/music/types";
import type { AlbumWithArtist, ArtistEarnings, TrackListItem } from "@/lib/music/repository";

type StatusKey = "statusDraft" | "statusPendingReview" | "statusPublished" | "statusArchived";
const STATUS_KEY: Record<ContentStatus, StatusKey> = {
  draft: "statusDraft",
  pending_review: "statusPendingReview",
  published: "statusPublished",
  archived: "statusArchived",
};
const INPUT = "w-full rounded-xl border border-subtle px-3 py-2 text-sm outline-none focus:border-fg";
const JSON_HEADERS = { "Content-Type": "application/json" };

type Overview = { artist: MusicArtistRow | null; tracks: TrackListItem[]; albums: AlbumWithArtist[]; earnings: ArtistEarnings | null };

type TrackFormState = {
  title: string;
  genre: MusicGenre | "";
  explicit: boolean;
  isPremium: boolean;
  priceRon: number;
  allowReels: boolean;
  audience: MusicAudience;
  albumId: string;
  trackNumber: string;
  coverUrl: string;
  licenseNote: string;
};

function emptyTrackForm(): TrackFormState {
  return {
    title: "",
    genre: "",
    explicit: false,
    isPremium: false,
    priceRon: MUSIC_DEFAULT_TRACK_PRICE_CENTS / 100,
    allowReels: true,
    audience: "general",
    albumId: "",
    trackNumber: "",
    coverUrl: "",
    licenseNote: "",
  };
}

/** Citește durata unui fișier audio local fără să-l urce — element `<audio>` temporar pe un blob URL. */
function readAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const ms = Math.round((audio.duration || 0) * 1000);
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("invalid_audio"));
    };
    audio.src = url;
  });
}

/** PUT direct pe R2 cu URL presemnat, raportând progresul prin XHR (fetch nu expune upload progress). */
function uploadWithProgress(url: string, file: File, contentType: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(String(xhr.status))));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(file);
  });
}

function GenrePicker({ value, onChange, t }: { value: MusicGenre | ""; onChange: (g: MusicGenre) => void; t: (key: string) => string }) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      {MUSIC_GENRES.map((g) => {
        const on = value === g;
        return (
          <label key={g} className={`cursor-pointer rounded-full px-3 py-1 text-xs font-bold ring-1 ${on ? "bg-fg text-fg-inverse ring-fg" : "bg-surface text-fg ring-fg/10"}`}>
            <input type="radio" className="sr-only" checked={on} onChange={() => onChange(g)} />
            {t(musicGenreLabelKey(g))}
          </label>
        );
      })}
    </fieldset>
  );
}

export default function CreatorMusicPage() {
  const t = useTranslations("music");
  const formatPrice = useFormatPrice();
  const [data, setData] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [form, setForm] = useState<TrackFormState>(emptyTrackForm());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<TrackFormState>(emptyTrackForm());

  const [albumForm, setAlbumForm] = useState({ title: "", coverUrl: "", releaseDate: "", priceRon: "" });

  const load = useCallback(() => {
    fetch("/api/creator/music").then((r) => r.json()).then(setData).catch(() => setMsg(t("loadError")));
  }, [t]);
  useEffect(load, [load]);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setDurationMs(null);
    setFileError(null);
    if (!f) return;
    if (!(MUSIC_ALLOWED_MIME as readonly string[]).includes(f.type)) {
      setFileError(t("fileType"));
      return;
    }
    if (f.size > MUSIC_MAX_UPLOAD_BYTES) {
      setFileError(t("fileTooLarge"));
      return;
    }
    try {
      const ms = await readAudioDuration(f);
      setDurationMs(ms);
      if (ms < MUSIC_MIN_DURATION_MS || ms > MUSIC_MAX_DURATION_MS) {
        setFileError(
          t("durationInvalid", {
            min: Math.round(MUSIC_MIN_DURATION_MS / 1000),
            max: Math.round(MUSIC_MAX_DURATION_MS / 60000),
          }),
        );
      }
    } catch {
      setFileError(t("fileType"));
    }
  };

  const canSubmit =
    !!file && !fileError && durationMs !== null && form.title.trim().length >= 2 && !!form.genre && form.licenseNote.trim().length >= 10;

  const submitTrack = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !file || durationMs === null) return;
    setMsg(null);
    setBusy(true);
    setProgress(0);
    try {
      const upRes = await fetch("/api/creator/music/upload-url", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
      });
      const upData = await upRes.json().catch(() => ({}));
      if (!upRes.ok) {
        setMsg(upData.error === "unsupported_type" ? t("fileType") : upData.error === "file_too_large" ? t("fileTooLarge") : t("uploadError"));
        return;
      }
      await uploadWithProgress(upData.url, file, file.type, setProgress);

      const trackRes = await fetch("/api/creator/music/tracks", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          trackId: upData.trackId,
          objectKey: upData.key,
          title: form.title,
          genre: form.genre,
          durationMs,
          explicit: form.explicit,
          isPremium: form.isPremium,
          priceCents: form.isPremium ? Math.round(form.priceRon * 100) : undefined,
          allowReels: form.allowReels,
          audience: form.audience,
          albumId: form.albumId || null,
          trackNumber: form.trackNumber ? Number(form.trackNumber) : null,
          coverUrl: form.coverUrl || null,
          licenseNote: form.licenseNote,
        }),
      });
      if (!trackRes.ok) {
        setMsg(t("uploadError"));
        return;
      }
      setMsg(t("uploadDone"));
      setForm(emptyTrackForm());
      setFile(null);
      setDurationMs(null);
      setFileError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      load();
    } catch {
      setMsg(t("uploadError"));
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const startEdit = (track: TrackListItem) => {
    setEditingId(track.id);
    setEditForm({
      title: track.title,
      genre: track.genre as MusicGenre,
      explicit: track.explicit,
      isPremium: track.is_premium,
      priceRon: (track.price_cents ?? MUSIC_DEFAULT_TRACK_PRICE_CENTS) / 100,
      allowReels: track.allow_reels,
      audience: track.audience,
      albumId: track.album_id ?? "",
      trackNumber: track.track_number ? String(track.track_number) : "",
      coverUrl: track.cover_url ?? "",
      licenseNote: track.license_note ?? "",
    });
  };

  const saveEdit = async (id: string) => {
    setMsg(null);
    const res = await fetch(`/api/creator/music/tracks/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: editForm.title,
        genre: editForm.genre,
        isPremium: editForm.isPremium,
        priceCents: editForm.isPremium ? Math.round(editForm.priceRon * 100) : undefined,
        allowReels: editForm.allowReels,
        audience: editForm.audience,
        coverUrl: editForm.coverUrl || null,
        albumId: editForm.albumId || null,
        trackNumber: editForm.trackNumber ? Number(editForm.trackNumber) : null,
      }),
    });
    if (!res.ok) {
      setMsg(t("error"));
      return;
    }
    setMsg(t("saved"));
    setEditingId(null);
    load();
  };

  const archiveTrack = async (id: string) => {
    if (!window.confirm(t("archive"))) return;
    const res = await fetch(`/api/creator/music/tracks/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "archived" }),
    });
    if (!res.ok) {
      setMsg(t("error"));
      return;
    }
    setMsg(t("saved"));
    load();
  };

  const createAlbum = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const res = await fetch("/api/creator/music/albums", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: albumForm.title,
        coverUrl: albumForm.coverUrl || null,
        releaseDate: albumForm.releaseDate || null,
        priceCents: albumForm.priceRon ? Math.round(Number(albumForm.priceRon) * 100) : null,
      }),
    });
    if (!res.ok) {
      setMsg(t("error"));
      return;
    }
    setMsg(t("saved"));
    setAlbumForm({ title: "", coverUrl: "", releaseDate: "", priceRon: "" });
    load();
  };

  if (!data) return <div className="p-6 text-sm text-muted">…</div>;
  if (!data.artist) {
    return <div className="m-6 rounded-2xl border border-warning/30 bg-warning-soft p-5 text-sm text-warning">{t("notArtist")}</div>;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-black"><Music size={22} /> {t("studio")}</h1>
        <p className="text-sm text-muted">{t("studioIntro")}</p>
      </header>

      {data.earnings && (
        <div className="rounded-2xl bg-fg p-4 text-fg-inverse">
          <p className="text-xs uppercase tracking-wider text-fg-inverse/60">{t("earnings")}</p>
          <p className="text-2xl font-black">{formatPrice(data.earnings.unlock_units, { sourceCurrency: "RON" })}</p>
          <p className="text-xs text-fg-inverse/60">
            {t("earningsUnlocks", { count: data.earnings.unlocks_count })}
          </p>
        </div>
      )}
      {msg && <p className="text-sm font-semibold text-success">{msg}</p>}

      <form onSubmit={submitTrack} className="space-y-2 rounded-2xl border border-subtle p-4">
        <h2 className="font-black">{t("newTrack")}</h2>

        <input
          ref={fileInputRef}
          required
          type="file"
          accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/aac"
          onChange={onFileChange}
          className={INPUT}
        />
        {durationMs !== null && (
          <p className="text-xs text-muted">{t("durationLabel")}: {Math.floor(durationMs / 60000)}:{String(Math.round((durationMs % 60000) / 1000)).padStart(2, "0")}</p>
        )}
        {fileError && <p className="text-xs font-semibold text-danger">{fileError}</p>}

        <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t("trackTitle")} className={INPUT} />

        <GenrePicker value={form.genre} onChange={(g) => setForm({ ...form, genre: g })} t={t} />

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.explicit} onChange={(e) => setForm({ ...form, explicit: e.target.checked })} /> {t("explicit")}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isPremium} onChange={(e) => setForm({ ...form, isPremium: e.target.checked })} /> {t("isPremium")}
        </label>
        {form.isPremium && (
          <label className="block text-xs">{t("priceLabel")}
            <input
              type="number"
              min={MUSIC_TRACK_PRICE_MIN_CENTS / 100}
              max={MUSIC_TRACK_PRICE_MAX_CENTS / 100}
              step={0.5}
              value={form.priceRon}
              onChange={(e) => setForm({ ...form, priceRon: Number(e.target.value) })}
              className={INPUT}
            />
          </label>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.allowReels} onChange={(e) => setForm({ ...form, allowReels: e.target.checked })} /> {t("allowReels")}
        </label>

        <label className="block text-xs">{t("audience")}
          <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as MusicAudience })} className={INPUT}>
            <option value="general">{t("audienceGeneral")}</option>
            <option value="kids">{t("audienceKids")}</option>
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">{t("album")}
            <select value={form.albumId} onChange={(e) => setForm({ ...form, albumId: e.target.value })} className={INPUT}>
              <option value="">{t("noAlbum")}</option>
              {data.albums.map((al) => <option key={al.id} value={al.id}>{al.title}</option>)}
            </select>
          </label>
          <label className="block text-xs">{t("trackNumber")}
            <input type="number" min={1} value={form.trackNumber} onChange={(e) => setForm({ ...form, trackNumber: e.target.value })} className={INPUT} />
          </label>
        </div>

        <input value={form.coverUrl} onChange={(e) => setForm({ ...form, coverUrl: e.target.value })} placeholder={t("coverUrl")} className={INPUT} />

        <textarea
          required
          minLength={10}
          value={form.licenseNote}
          onChange={(e) => setForm({ ...form, licenseNote: e.target.value })}
          placeholder={t("licenseNote")}
          rows={2}
          className={INPUT}
        />
        <p className="text-xs text-muted">{t("licenseHint")}</p>

        <button type="submit" disabled={busy || !canSubmit} className="rounded-xl bg-fg px-4 py-2 text-sm font-bold text-fg-inverse disabled:opacity-50">
          {busy ? `${t("uploading")} ${progress}%` : <><UploadCloud size={14} className="inline" /> {" "}{t("upload")}</>}
        </button>
      </form>

      <section className="space-y-2">
        <h2 className="font-black">{t("tracks")}</h2>
        {data.tracks.map((track) => (
          <div key={track.id} className="rounded-2xl border border-subtle p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-bold">{track.title}</p>
                <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
                  <span>{t(STATUS_KEY[track.status])}</span>
                  {track.is_premium && <span>· {t("premium")}</span>}
                  {track.explicit && <span>· {t("explicitBadge")}</span>}
                  <span className="inline-flex items-center gap-1">· <Headphones size={12} /> {t("plays7d", { count: track.plays_7d })}</span>
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={() => startEdit(track)} className="rounded-lg border border-subtle px-2 py-1 text-xs font-bold">{t("edit")}</button>
                {track.status !== "archived" && (
                  <button type="button" onClick={() => archiveTrack(track.id)} className="rounded-lg bg-fg px-2 py-1 text-xs font-bold text-fg-inverse">{t("archive")}</button>
                )}
              </div>
            </div>

            {editingId === track.id && (
              <div className="mt-3 space-y-2 border-t border-subtle pt-3">
                <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} placeholder={t("trackTitle")} className={INPUT} />
                <GenrePicker value={editForm.genre} onChange={(g) => setEditForm({ ...editForm, genre: g })} t={t} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editForm.isPremium} onChange={(e) => setEditForm({ ...editForm, isPremium: e.target.checked })} /> {t("isPremium")}
                </label>
                {editForm.isPremium && (
                  <input
                    type="number"
                    min={MUSIC_TRACK_PRICE_MIN_CENTS / 100}
                    max={MUSIC_TRACK_PRICE_MAX_CENTS / 100}
                    step={0.5}
                    value={editForm.priceRon}
                    onChange={(e) => setEditForm({ ...editForm, priceRon: Number(e.target.value) })}
                    className={INPUT}
                  />
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editForm.allowReels} onChange={(e) => setEditForm({ ...editForm, allowReels: e.target.checked })} /> {t("allowReels")}
                </label>
                <select value={editForm.audience} onChange={(e) => setEditForm({ ...editForm, audience: e.target.value as MusicAudience })} className={INPUT}>
                  <option value="general">{t("audienceGeneral")}</option>
                  <option value="kids">{t("audienceKids")}</option>
                </select>
                <input value={editForm.coverUrl} onChange={(e) => setEditForm({ ...editForm, coverUrl: e.target.value })} placeholder={t("coverUrl")} className={INPUT} />
                <div className="flex gap-2">
                  <button type="button" onClick={() => saveEdit(track.id)} className="rounded-xl bg-fg px-4 py-2 text-sm font-bold text-fg-inverse">{t("save")}</button>
                  <button type="button" onClick={() => setEditingId(null)} className="rounded-xl border border-subtle px-4 py-2 text-sm font-bold">{t("cancel")}</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="space-y-2 rounded-2xl border border-subtle p-4">
        <h2 className="font-black">{t("albums")}</h2>
        {data.albums.length > 0 && (
          <ul className="space-y-1 text-sm">
            {data.albums.map((al) => <li key={al.id}>{al.title} · {al.track_count}</li>)}
          </ul>
        )}
        <form onSubmit={createAlbum} className="grid gap-2 sm:grid-cols-2">
          <input required value={albumForm.title} onChange={(e) => setAlbumForm({ ...albumForm, title: e.target.value })} placeholder={t("albumTitle")} className={INPUT} />
          <input value={albumForm.coverUrl} onChange={(e) => setAlbumForm({ ...albumForm, coverUrl: e.target.value })} placeholder={t("coverUrl")} className={INPUT} />
          <input type="date" value={albumForm.releaseDate} onChange={(e) => setAlbumForm({ ...albumForm, releaseDate: e.target.value })} className={INPUT} />
          <input type="number" min={0} step={0.5} value={albumForm.priceRon} onChange={(e) => setAlbumForm({ ...albumForm, priceRon: e.target.value })} placeholder={t("priceLabel")} className={INPUT} />
          <button type="submit" className="rounded-xl bg-fg px-4 py-2 text-sm font-bold text-fg-inverse sm:col-span-2"><Plus size={14} className="inline" /> {" "}{t("albums")}</button>
        </form>
      </section>
    </div>
  );
}
