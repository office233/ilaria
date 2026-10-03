import { Link } from "@/lib/i18n/navigation";
import Image from "next/image";
import { redirect } from "@/lib/i18n/navigation";
import { ArrowLeft, Play } from "lucide-react";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { getLocale, getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

type Row = {
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  view_count: string;
  created_at: string;
};

export default async function LikedVideosPage() {
  const t = await getTranslations("likedVideos");
  const user = await getAuthUser();
  if (!user.userId) return redirect({ href: "/account?redirect=/account/liked", locale: await getLocale() });

  const { rows } = await dbQuery<Row>(
    `SELECT l.video_id, v.title, v.thumbnail_url, v.view_count, l.created_at
       FROM likes l
       JOIN videos v ON v.id = l.video_id
      WHERE l.user_id = $1
        AND l.video_id IS NOT NULL
      ORDER BY l.created_at DESC
      LIMIT 200`,
    [user.userId],
  );

  return (
    <main className="min-h-screen bg-black text-white pb-24">
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-black/80 backdrop-blur border-b border-white/10">
        <Link href="/account" className="p-1 -ml-1">
          <ArrowLeft size={22} />
        </Link>
        <h1 className="text-lg font-black">{t("title")}</h1>
      </header>
      <div className="px-2 md:px-6 pt-3 max-w-5xl mx-auto">
        {rows.length === 0 ? (
          <p className="text-white/50 text-sm mt-8 text-center">{t("empty")}</p>
        ) : (
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5 md:gap-3">
            {rows.map((r) => (
              <Link
                key={r.video_id}
                href={`/video/${r.video_id}`}
                className="relative aspect-[9/16] rounded-md overflow-hidden bg-white/5 group"
              >
                {r.thumbnail_url ? (
                  <Image
                    src={r.thumbnail_url}
                    alt={r.title}
                    fill
                    sizes="(max-width:768px) 33vw, 20vw"
                    className="object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-white/40">
                    <Play size={28} />
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5">
                  <div className="text-[10px] md:text-xs font-semibold line-clamp-1">{r.title}</div>
                  <div className="text-[10px] text-white/60 flex items-center gap-1">
                    <Play size={9} fill="currentColor" />
                    {Number(r.view_count).toLocaleString("ro-RO")}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
