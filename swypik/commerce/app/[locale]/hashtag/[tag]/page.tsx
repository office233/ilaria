import { Link } from "@/lib/i18n/navigation";
import { Heart } from "lucide-react";
import { dbQuery } from "@/lib/db";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

type Params = { tag: string };

type Video = {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  view_count: number;
  like_count: number;
  creator_name: string | null;
};

export default async function HashtagPage({
  params,
}: {
  params: Promise<Params & { locale: string }>;
}) {
  const p = await params;
  const t = await getTranslations({ locale: p.locale, namespace: "hashtag" });
  const raw = decodeURIComponent(p.tag || "").replace(/^#+/, "").trim().toLowerCase();

  const { rows } = await dbQuery<Video>(
    `SELECT v.id::text AS id, v.title, v.thumbnail_url,
            COALESCE(v.view_count,0)::int AS view_count,
            COALESCE(v.like_count,0)::int AS like_count,
            COALESCE(u.display_name, u.username) AS creator_name
     FROM videos v
     LEFT JOIN users u ON u.id = v.creator_id
     WHERE v.status = 'ready' AND v.visibility = 'public'
       AND COALESCE(v.is_hidden, false) = false
       AND v.effective_label = 'safe'
       AND EXISTS (SELECT 1 FROM unnest(v.tags) t WHERE lower(t) = $1)
     ORDER BY COALESCE(v.like_count,0) DESC, v.published_at DESC NULLS LAST
     LIMIT 60`,
    [raw],
  );

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-6">
          <h1 className="text-3xl font-bold">#{raw}</h1>
          <p className="text-sm text-neutral-400 mt-1">{t("videoCount", { count: rows.length })}</p>
        </header>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-8 text-center text-neutral-400">
            {t("noVideos")}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {rows.map((v) => (
              <Link
                key={v.id}
                href={`/video/${v.id}`}
                className="group rounded-lg overflow-hidden bg-neutral-900 border border-neutral-800"
              >
                <div className="aspect-[9/16] bg-neutral-800 relative">
                  {v.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnail_url} alt={v.title ?? ""} className="w-full h-full object-cover" />
                  ) : null}
                  <div className="absolute bottom-1 left-2 flex items-center gap-1 text-xs">
                    <Heart size={12} className="fill-current" /> {Intl.NumberFormat().format(v.like_count)}
                  </div>
                </div>
                <div className="p-2">
                  <div className="text-sm font-medium truncate">{v.title ?? t("untitled")}</div>
                  <div className="text-xs text-neutral-400 truncate">{v.creator_name ?? "—"}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
