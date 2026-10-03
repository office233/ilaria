/**
 * Configurația UNICĂ a navigării Creator Studio — folosită de sidebar-ul
 * desktop (SidebarNav) și de meniul mobil (MobileDashboardNav).
 * `icon` = cheie din ICONS-urile lui MobileDashboardNav / SidebarNav.
 * `labelKey` = cheie în `creatorStudio.nav`.
 */
export type CreatorNavIcon =
  | "barChart3"
  | "upload"
  | "clapperboard"
  | "music"
  | "fileText"
  | "trendingUp"
  | "coins"
  | "banknote"
  | "circleDot";

export type CreatorNavLabelKey =
  | "overview"
  | "upload"
  | "videos"
  | "movies"
  | "music"
  | "drafts"
  | "analytics"
  | "earnings"
  | "payouts"
  | "live";

export type CreatorNavEntry = { href: string; icon: CreatorNavIcon; labelKey: CreatorNavLabelKey };

export type CreatorNavFlags = { movies: boolean; music: boolean };

export function creatorNavEntries(flags: CreatorNavFlags): CreatorNavEntry[] {
  return [
    { href: "/creator", icon: "barChart3", labelKey: "overview" },
    { href: "/upload", icon: "upload", labelKey: "upload" },
    { href: "/creator/videos", icon: "clapperboard", labelKey: "videos" },
    ...(flags.movies ? [{ href: "/creator/movies", icon: "clapperboard", labelKey: "movies" } as const] : []),
    ...(flags.music ? [{ href: "/creator/music", icon: "music", labelKey: "music" } as const] : []),
    { href: "/creator/drafts", icon: "fileText", labelKey: "drafts" },
    { href: "/creator/analytics", icon: "trendingUp", labelKey: "analytics" },
    { href: "/creator/earnings", icon: "coins", labelKey: "earnings" },
    { href: "/creator/payouts", icon: "banknote", labelKey: "payouts" },
    { href: "/creator/live", icon: "circleDot", labelKey: "live" },
  ];
}
