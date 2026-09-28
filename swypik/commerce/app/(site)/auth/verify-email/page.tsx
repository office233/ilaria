import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import VerifyEmailClient from "./VerifyEmailClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authEmail.verifyPage");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/** Pagina din linkul de confirmare a emailului (token de unică folosință). */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <VerifyEmailClient token={typeof token === "string" ? token : ""} />;
}
