// Wrapper centralizat pentru navigarea localizată.
// Re-exportă Link, redirect, usePathname, useRouter — toate localizate.
// Schimbarea importurilor de la `next/link` → acest fișier face ca navigarea
// să PĂSTREZE prefixul curent de limbă (ex.: pe /en/cart, <Link href="/explore">
// merge la /en/explore, nu la /explore).
import { createNavigation } from "next-intl/navigation";
import { routing } from "@/lib/i18n/routing";

export const { Link, redirect, permanentRedirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
