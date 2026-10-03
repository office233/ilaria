import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authEmail.layout");
  return { title: t("metaTitle"), description: t("metaDescription") };
}

/** Ecranele de autentificare sunt mereu pe tema închisă (tokenuri, nu hex). */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-theme="dark" className="min-h-[100dvh] bg-canvas text-white">
      {children}
    </div>
  );
}
