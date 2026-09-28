import { Link } from "@/lib/i18n/navigation";
import Image from "next/image";
import { notFound } from "next/navigation";
import { dbQuery } from "@/lib/db";
import { isBigintIdParam } from "@/lib/validation/params";
import { Music2, Play, ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { notHiddenByViewerSql, visibleVideoSql } from "@/lib/feed/visibility";
import { getOptionalSocialUserId } from "@/lib/social/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AudioTrackRow = {
  id: string;
  title: string;
  artist: string;
  duration_s: number;
  image_url: string | null;
  audio_url: string;
  plays_count: number;
  genre: string | null;
  attribution_url: string | null;
};

type VideoRow = {
  id: string;
  thumbnail_url: string | null;
  description: string | null;
  view_count: string;
  creator_username: string | null;
};

function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

export default async function AudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations("audioPage");
  if (!isBigintIdParam(id)) notFound();

  const trackRes = await dbQuery<AudioTrackRow>(
    `SELECT id::text, title, artist, duration_s, image_url, audio_url, plays_count, genre, attribution_url
     FROM audio_tracks WHERE id = $1::bigint AND is_active = true LIMIT 1`,
    [id]
  );
  const track = trackRes.rows[0];
  if (!track) notFound();

  // Regulile comune ale feed-ului + ce a ascuns/blocat viewerul (lib/feed/visibility).
  const viewerId = await getOptionalSocialUserId().catch(() => null);
  const videosRes = await dbQuery<VideoRow>(
    `SELECT v.id::text, v.thumbnail_url, v.description, v.view_count::text,
            u.username AS creator_username
     FROM videos v
     LEFT JOIN users u ON u.id = v.creator_id
     WHERE v.audio_track_id = $1::bigint
       AND ${visibleVideoSql()}
       ${notHiddenByViewerSql(viewerId ? "$2" : null)}
     ORDER BY v.view_count DESC NULLS LAST, v.published_at DESC NULLS LAST
     LIMIT 60`,
    viewerId ? [id, viewerId] : [id]
  );
  const videos = videosRes.rows;

  return (
    <main style={{ background: "#000", color: "#fff", minHeight: "100dvh", paddingBottom: 80 }}>
      <header style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)", padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <Link href="/explore" aria-label={t("back")} style={{ color: "#fff", display: "flex" }}>
          <ArrowLeft size={22} />
        </Link>
        <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Audio</h1>
      </header>

      <section style={{ padding: "24px 16px", display: "flex", gap: 16, alignItems: "center" }}>
        <div style={{ width: 110, height: 110, borderRadius: 14, overflow: "hidden", background: "linear-gradient(135deg,#7C3AED,#7C3AED)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {track.image_url ? (
            <Image src={track.image_url} alt="" width={110} height={110} unoptimized style={{ objectFit: "cover", width: "100%", height: "100%" }} />
          ) : (
            <Music2 size={42} color="#fff" />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{track.title}</h2>
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", margin: "0 0 6px 0" }}>{track.artist}</p>
          <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", margin: 0 }}>
            {formatDuration(track.duration_s)} · {t("videoCount", { count: videos.length })}
            {track.genre ? ` · ${track.genre}` : ""}
          </p>
        </div>
      </section>

      <section style={{ padding: "0 16px 16px" }}>
        <audio controls preload="none" src={track.audio_url} style={{ width: "100%" }}>
          {t("audioUnsupported")}
        </audio>
        {track.attribution_url && (
          <a href={track.attribution_url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
            {t("licenseSource")}
          </a>
        )}
      </section>

      <section style={{ padding: "8px 16px 24px" }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: "rgba(255,255,255,0.8)", margin: "8px 0 12px 0", textTransform: "uppercase", letterSpacing: 0.5 }}>
          {t("videosWithSound")}
        </h3>
        {videos.length === 0 ? (
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.5)" }}>{t("noVideos")}</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3 }}>
            {videos.map((v) => (
              <Link key={v.id} href={`/explore?v=${v.id}`} style={{ position: "relative", aspectRatio: "9/16", background: "#1a1a1a", overflow: "hidden", borderRadius: 4 }}>
                {v.thumbnail_url ? (
                  <Image src={v.thumbnail_url} alt={v.description || "Video"} fill sizes="33vw" unoptimized style={{ objectFit: "cover" }} />
                ) : null}
                <span style={{ position: "absolute", bottom: 4, left: 6, fontSize: 11, color: "#fff", display: "flex", alignItems: "center", gap: 3, textShadow: "0 1px 2px rgba(0,0,0,0.9)" }}>
                  <Play size={11} fill="#fff" />
                  {v.view_count || "0"}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
