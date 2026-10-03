import { redirect as nextRedirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { getPathname, redirect } from "@/lib/i18n/navigation";
import { VIDEO_AUTHOR_ROLES } from "@/lib/video/auth";

/**
 * Poarta paginilor de creare (/upload, /reels/record): login cu întoarcere pe
 * aceeași pagină, cu prefixul de limbă păstrat (/auth/login e o rută fără
 * limbă, deci `next` primește calea localizată: /en/upload?draft=…), apoi rolul
 * de autor video. Nu promovează niciodată rolul pe un GET.
 */
export async function guardCreatePage(
  locale: string,
  pathname: string,
  query: Record<string, string | undefined> = {},
): Promise<void> {
  const auth = await getAuthUser();
  if (auth.role === "guest" || !auth.userId) {
    const clean = Object.fromEntries(
      Object.entries(query).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""),
    );
    // Fără parametri → fără `?` gol la final (next=%2Fupload%3F).
    const href = Object.keys(clean).length > 0 ? { pathname, query: clean } : pathname;
    const next = getPathname({ href, locale });
    nextRedirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }
  if (!VIDEO_AUTHOR_ROLES.has(auth.role)) {
    redirect({ href: "/become-a-creator", locale });
  }
}
