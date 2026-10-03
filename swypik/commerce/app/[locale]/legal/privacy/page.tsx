import { redirect } from "@/lib/i18n/navigation";
export const dynamic = "force-dynamic";
export default async function LegacyPrivacyRedirect({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return redirect({ href: "/privacy", locale });
}
