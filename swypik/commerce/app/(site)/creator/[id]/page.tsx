import { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { dbQuery } from "@/lib/db";
import { normalizeViewerUserId } from "@/lib/social/user-profile";

/* ─── Types ─── */
interface CreatorProfile {
  id: string;
  display_name: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  is_verified: boolean;
  video_count: number;
  total_views: number;
}

interface CreatorVideo {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  playback_url: string | null;
  duration_ms: number | null;
  view_count: number;
  like_count: number;
  published_at: string | null;
}

/* ─── Validation ─── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ─── Data fetching (server-side only) ─── */
async function getCreatorData(id: string) {
  if (!UUID_RE.test(id)) return null;
  const { rows: profileRows } = await dbQuery(
    `SELECT
       u.id,
       u.display_name,
       u.username,
       u.avatar_url,
       u.bio,
       cp.verification_status = 'verified' AS is_verified,
       (SELECT COUNT(*)
          FROM videos
         WHERE creator_id = u.id
           AND status     = 'ready'
           AND visibility = 'public'
           AND COALESCE(is_hidden, false) = false
           AND effective_label = 'safe') AS video_count,
       (SELECT COALESCE(SUM(view_count), 0)
          FROM videos
         WHERE creator_id = u.id
           AND status     = 'ready'
           AND visibility = 'public'
           AND COALESCE(is_hidden, false) = false
           AND effective_label = 'safe') AS total_views
     FROM users u
     LEFT JOIN creator_profiles cp ON cp.user_id = u.id
     WHERE u.id = $1`,
    [id],
  );

  if (profileRows.length === 0) return null;

  const p = profileRows[0];

  const { rows: videoRows } = await dbQuery(
    `SELECT
       id,
       title,
       thumbnail_url,
       playback_url,
       duration_ms,
       view_count,
       like_count,
       published_at
     FROM videos
     WHERE creator_id = $1
       AND status     = 'ready'
       AND visibility = 'public'
       AND COALESCE(is_hidden, false) = false
       AND effective_label = 'safe'
     ORDER BY published_at DESC
     LIMIT 30`,
    [id],
  );

  const creator: CreatorProfile = {
    id: p.id,
    display_name: p.display_name || "Creator",
    username: p.username || "",
    avatar_url: p.avatar_url,
    bio: p.bio,
    is_verified: p.is_verified,
    video_count: Number(p.video_count),
    total_views: Number(p.total_views),
  };

  const videos: CreatorVideo[] = videoRows.map((v: any) => ({
    id: v.id,
    title: v.title,
    thumbnail_url: v.thumbnail_url,
    playback_url: v.playback_url,
    duration_ms: v.duration_ms,
    view_count: v.view_count ?? 0,
    like_count: v.like_count ?? 0,
    published_at: v.published_at,
  }));

  return { creator, videos };
}

async function getCanonicalUsernameForCreatorId(id: string) {
  if (!normalizeViewerUserId(id)) return null;

  const { rows } = await dbQuery<{ username: string | null }>(
    `SELECT username
       FROM users
      WHERE id = $1
        AND status = 'active'
      LIMIT 1`,
    [id],
  );

  return rows[0]?.username || null;
}

/* ─── Helpers ─── */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function formatDuration(ms: number | null): string {
  if (!ms) return "";
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/* ─── SEO Metadata ─── */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tx = await getTranslations("creatorProfile");
  const data = await getCreatorData(id);
  if (!data) {
    return { title: tx("metaTitleFallback") };
  }
  return {
    title: tx("metaTitleFor", { name: data.creator.display_name }),
    description: data.creator.bio
      ? data.creator.bio.slice(0, 160)
      : tx("metaDescFallback", { name: data.creator.display_name }),
    openGraph: {
      title: tx("metaTitleFor", { name: data.creator.display_name }),
      description: data.creator.bio || tx("ogDescFallback"),
      type: "profile",
      images: data.creator.avatar_url ? [data.creator.avatar_url] : [],
    },
  };
}

/* ─── Page Component (Server) ─── */
export default async function CreatorPublicPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("creator");
  const { id } = await params;
  const tx = await getTranslations("creatorProfile");
  const canonicalUsername = await getCanonicalUsernameForCreatorId(id).catch(() => null);
  if (canonicalUsername) redirect(`/u/${encodeURIComponent(canonicalUsername)}`);

  const data = await getCreatorData(id);
  if (!data) notFound();

  const { creator, videos } = data;

  const totalLikes = videos.reduce((sum, v) => sum + (v.like_count ?? 0), 0);

  return (
    <ImmersiveSurface>
    <div className="min-h-screen" style={{ background: "rgb(var(--canvas))" }}>
      {/* ── Sticky Header Bar ── */}
      <header
        className="sticky top-0 z-50 backdrop-blur-xl border-b"
        style={{
          background: "rgb(var(--canvas) / 0.85)",
          borderColor: "rgb(var(--fg) / 0.06)",
        }}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="text-lg font-black tracking-tight"
            style={{ color: "rgb(var(--fg))" }}
          >
            Swypik
          </Link>
          <Link
            href="/explore"
            className="text-sm font-bold px-4 py-2 rounded-xl transition-all duration-200"
            style={{
              background: "rgb(var(--canvas))",
              color: "rgb(var(--fg))",
            }}
          >
            
            {t("exploreaza")}
          </Link>
        </div>
      </header>

      {/* ── Hero Section ── */}
      <section className="relative overflow-hidden">
        {/* Gradient backdrop */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(16,163,127,0.15), transparent 70%)",
          }}
        />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-12 pb-8 sm:pt-16 sm:pb-10 flex flex-col items-center text-center">
          {/* Avatar */}
          <div className="relative mb-5">
            {creator.avatar_url ? (
              <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-full overflow-hidden ring-4 ring-[rgb(var(--canvas))]/30 shadow-2xl">
                <Image
                  src={creator.avatar_url}
                  alt={creator.display_name}
                  width={128}
                  height={128}
                  className="w-full h-full object-cover"
                  priority
                />
              </div>
            ) : (
              <div
                className="w-28 h-28 sm:w-32 sm:h-32 rounded-full flex items-center justify-center ring-4 ring-[rgb(var(--canvas))]/30 shadow-2xl select-none"
                style={{
                  background:
                    "linear-gradient(135deg, rgb(var(--canvas)) 0%, rgb(var(--brand)) 50%, rgb(var(--brand-hover)) 100%)",
                }}
              >
                <span className="text-4xl sm:text-5xl font-black text-fg/90">
                  {getInitials(creator.display_name)}
                </span>
              </div>
            )}

            {/* Verified badge */}
            {creator.is_verified && (
              <div
                className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full flex items-center justify-center shadow-lg"
                style={{ background: "rgb(var(--canvas))" }}
                title={tx("creatorVerified")}
              >
                <svg
                  className="w-5 h-5 text-fg"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            )}
          </div>

          {/* Name + username */}
          <h1 className="text-3xl sm:text-4xl font-black text-fg tracking-tight mb-1">
            {creator.display_name}
          </h1>
          {creator.username && (
            <p className="text-sm font-semibold mb-4" style={{ color: "rgb(var(--fg-muted))" }}>
              @{creator.username}
            </p>
          )}

          {/* Bio */}
          {creator.bio && (
            <p
              className="max-w-md text-sm leading-relaxed mb-6"
              style={{ color: "rgb(var(--fg-subtle))" }}
            >
              {creator.bio}
            </p>
          )}

          {/* Stats bar */}
          <div
            className="flex items-center gap-0 rounded-2xl overflow-hidden shadow-xl"
            style={{
              background: "rgb(var(--fg) / 0.04)",
              border: "1px solid rgb(var(--fg) / 0.06)",
            }}
          >
            <StatPill label={tx("statVideos")} value={formatCount(creator.video_count)} />
            <div className="w-px h-10" style={{ background: "rgb(var(--fg) / 0.06)" }} />
            <StatPill label={tx("statViews")} value={formatCount(creator.total_views)} />
            <div className="w-px h-10" style={{ background: "rgb(var(--fg) / 0.06)" }} />
            <StatPill label={tx("statLikes")} value={formatCount(totalLikes)} />
          </div>
        </div>
      </section>

      {/* ── Divider ── */}
      <div
        className="max-w-6xl mx-auto"
        style={{ borderTop: "1px solid rgb(var(--fg) / 0.06)" }}
      />

      {/* ── Video Grid Section ── */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {videos.length === 0 ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-20 gap-5">
            <div
              className="w-20 h-20 rounded-3xl flex items-center justify-center"
              style={{ background: "rgba(16,163,127,0.1)" }}
            >
              <svg
                className="w-10 h-10"
                style={{ color: "rgb(var(--canvas))" }}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9A2.25 2.25 0 0 0 13.5 5.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-lg font-black text-fg mb-1">
                {tx("noVideosPublished")}
              </p>
              <p className="text-sm" style={{ color: "rgb(var(--fg-muted))" }}>

                {t("acestCreatorNuAre")}
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Section header */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-black text-fg tracking-tight">
                {tx("clipsHeading")}
              </h2>
              <span className="text-xs font-bold" style={{ color: "rgb(var(--fg-muted))" }}>
                {creator.video_count} {creator.video_count === 1 ? tx("clipSingular") : tx("clipPlural")}
              </span>
            </div>

            {/* Responsive grid: 2 col mobile, 3 tablet, 4 desktop */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {videos.map((video) => (
                <VideoCard key={video.id} video={video} videoAltFallback={tx("videoAltFallback")} />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ── Footer ── */}
      <footer
        className="border-t py-8 text-center"
        style={{
          borderColor: "rgb(var(--fg) / 0.06)",
        }}
      >
        <Link
          href="/"
          className="text-sm font-black tracking-tight"
          style={{ color: "rgb(var(--fg-muted))" }}
        >
          Swypik
        </Link>
        <p className="text-xs mt-1" style={{ color: "rgb(var(--fg-subtle))" }}>
          {tx("footerTagline")}
        </p>
      </footer>
    </div>
    </ImmersiveSurface>
  );
}

/* ─── Sub-components ─── */
function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center px-6 sm:px-8 py-3">
      <span className="text-lg sm:text-xl font-black text-fg leading-none">
        {value}
      </span>
      <span className="text-[11px] font-semibold mt-1" style={{ color: "rgb(var(--fg-muted))" }}>
        {label}
      </span>
    </div>
  );
}

function VideoCard({ video, videoAltFallback }: { video: CreatorVideo; videoAltFallback: string }) {
  const duration = formatDuration(video.duration_ms);

  return (
    <Link
      href={`/explore?v=${video.id}`}
      className="group relative block rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1"
      style={{
        background: "rgb(var(--surface))",
      }}
    >
      {/* Thumbnail area — 9:16 aspect ratio */}
      <div className="relative aspect-[9/16] w-full overflow-hidden">
        {video.thumbnail_url ? (
          <Image
            src={video.thumbnail_url}
            alt={video.title ?? videoAltFallback}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            className="object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              background:
                "linear-gradient(135deg, rgb(var(--surface)) 0%, rgb(var(--surface-2)) 100%)",
            }}
          >
            <svg
              className="w-10 h-10"
              style={{ color: "rgb(var(--fg-subtle))" }}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"
              />
            </svg>
          </div>
        )}

        {/* Gradient overlay at bottom */}
        <div
          className="absolute inset-x-0 bottom-0 h-24 pointer-events-none"
          style={{
            background:
              "linear-gradient(to top, rgba(0,0,0,0.7), transparent)",
          }}
        />

        {/* Duration badge */}
        {duration && (
          <div
            className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md text-[11px] font-bold text-fg"
            style={{ background: "rgba(0,0,0,0.7)" }}
          >
            {duration}
          </div>
        )}

        {/* View count */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1">
          <svg
            className="w-3 h-3 text-fg/80"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
            <path
              fillRule="evenodd"
              d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
              clipRule="evenodd"
            />
          </svg>
          <span className="text-[11px] font-bold text-fg/80">
            {formatCount(video.view_count)}
          </span>
        </div>

        {/* Play overlay on hover */}
        <div className="absolute inset-0 bg-overlay/30 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center pointer-events-none">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center shadow-xl"
            style={{ background: "rgb(var(--fg) / 0.9)" }}
          >
            <svg
              className="w-5 h-5 ml-0.5"
              style={{ color: "rgb(var(--canvas))" }}
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Title */}
      {video.title && (
        <div className="px-3 py-3">
          <p className="text-xs font-bold text-fg/90 leading-tight line-clamp-2">
            {video.title}
          </p>
        </div>
      )}
    </Link>
  );
}
