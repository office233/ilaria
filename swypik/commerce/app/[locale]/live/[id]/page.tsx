import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import LiveViewer from "@/components/live/viewer/LiveViewer";
import { getAuthSession } from "@/lib/auth/session";
import { isLiveMediaConfigured, LIVE_CONFIG } from "@/lib/live/config";
import { getLiveItems, getLiveStream } from "@/lib/live/queries";
import { isUuidParam } from "@/lib/validation/params";
import { localizedAlternates } from "@/lib/seo/hreflang";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, locale } = await params;
  const t = await getTranslations({ locale, namespace: "live.viewer" });
  if (!isUuidParam(id)) return { title: t("metaTitleFallback") };
  const stream = await getLiveStream(id).catch(() => null);
  return { title: stream?.title ? t("metaTitle", { title: stream.title }) : t("metaTitleFallback"), alternates: localizedAlternates(locale, `/live/${id}`) };
}

export default async function LiveViewerPage({ params }: Props) {
  const { id } = await params;
  if (!isUuidParam(id)) notFound();
  const stream = await getLiveStream(id);
  if (!stream) notFound();
  const [items, session] = await Promise.all([getLiveItems(id), getAuthSession().catch(() => null)]);

  return (
    <ImmersiveSurface fullscreen>
      <LiveViewer
        initialStream={stream}
        initialItems={items}
        configured={isLiveMediaConfigured()}
        signedIn={Boolean(session)}
        pollMs={LIVE_CONFIG.viewerPollMs}
      />
    </ImmersiveSurface>
  );
}
