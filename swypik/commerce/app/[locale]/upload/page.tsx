import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import CreateFlow from "@/components/upload/CreateFlow";
import { guardCreatePage } from "@/components/upload/createPageGuard";
import { isUuid } from "@/lib/video/upload-session";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ draft?: string; mission?: string; audio?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "videoUpload" });
  return { title: t("pageTitle"), robots: { index: false } };
}

/** Crearea unui clip: alege din galerie / filmează → editare → detalii → publicare. */
export default async function UploadPage({ params, searchParams }: Props) {
  const { locale } = await params;
  const { draft, mission, audio } = await searchParams;
  await guardCreatePage(locale, "/upload", { draft, mission, audio });
  const draftVideoId = draft && isUuid(draft) ? draft : undefined;
  // Din pagina misiunii: /upload?mission=<uuid> preselectează misiunea în picker.
  const missionId = mission && isUuid(mission) ? mission : undefined;
  // „Folosește sunetul” din Music: /upload?audio=<audio_track_id>
  const audioTrackId = audio && /^\d{1,12}$/.test(audio) ? Number(audio) : undefined;
  return (
    <CreateFlow initialSource="pick" draftVideoId={draftVideoId} missionId={missionId} audioTrackId={audioTrackId} />
  );
}
