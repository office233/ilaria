import "./globals.css";
import type { Metadata, Viewport } from "next";
import { APP_URL } from "@/lib/app-url";
import { THEME_COLORS } from "@/lib/theme/theme-color";

const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const appUrl =
  rawAppUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(rawAppUrl)
    ? rawAppUrl
    : APP_URL;

// metadataBase e independent de locale — singurul lucru din generateMetadata
// pe care root layout-ul mai are voie să-l seteze. Title/description/skip-link
// traduse trăiesc acum în app/[locale]/layout.tsx și app/(site)/layout.tsx,
// care au locale-ul disponibil explicit (din URL, respectiv din cookie/DB/
// header) fără să forțeze randare dinamică pe rutele [locale].
export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  keywords: "swypik, social commerce, video shopping, romania, produse, oferte, creators, tiktok shopping",
};

// viewportFit "cover": fără el toate `env(safe-area-inset-*)` sunt 0 pe iOS.
// theme-color inițial după prefers-color-scheme; ThemeColorSync îl ajustează
// apoi după tema aleasă de utilizator și pe suprafețele imersive.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
};

// Root layout pass-through (pattern next-intl pentru static rendering).
// <html>/<body> sunt randate de app/[locale]/layout.tsx (static, locale din URL)
// și de app/(site)/layout.tsx (rute fără prefix, dinamic) prin AppShell.
// NU apela cookies()/headers()/getLocale() aici: root layout-ul nu vede
// parametrul [locale], deci orice request API ar face TOATE rutele dinamice.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
