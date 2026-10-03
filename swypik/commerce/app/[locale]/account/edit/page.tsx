import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { EditProfileForm } from "@/components/social/profile/edit/EditProfileForm";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "accountEdit" });
  return { title: t("editeazaProfilul"), robots: { index: false, follow: false } };
}

export default async function EditProfilePage({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "accountEdit" });
  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/account" title={t("editeazaProfilul")} />
      <EditProfileForm />
    </div>
  );
}
