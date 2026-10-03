import { Link } from "@/lib/i18n/navigation";
import { redirect } from "@/lib/i18n/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import HiddenVideosList from "./HiddenVideosList";

export const dynamic = "force-dynamic";

type Row = {
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  hidden_at: string;
  reason: string;
};

export default async function HiddenVideosPage() {
  const t = await getTranslations("hiddenVideos");
  const user = await getAuthUser();
  if (!user.userId) return redirect({ href: "/account?redirect=/account/hidden", locale: await getLocale() });

  const { rows } = await dbQuery<Row>(
    `SELECT h.video_id, v.title, v.thumbnail_url, h.hidden_at, h.reason
       FROM user_hidden_videos h
       JOIN videos v ON v.id = h.video_id
      WHERE h.user_id = $1
      ORDER BY h.hidden_at DESC
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
      <div className="px-4 pt-4 max-w-2xl mx-auto">
        {rows.length === 0 ? (
          <p className="text-white/50 text-sm mt-8 text-center">
            {t("empty")}
          </p>
        ) : (
          <HiddenVideosList
            initial={rows.map((r) => ({
              videoId: r.video_id,
              title: r.title,
              thumbnailUrl: r.thumbnail_url,
              hiddenAt: r.hidden_at,
              reason: r.reason,
            }))}
          />
        )}
      </div>
    </main>
  );
}
