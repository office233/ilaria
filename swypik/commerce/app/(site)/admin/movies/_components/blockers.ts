import type { LicenseProblem } from "@/lib/movies/license";

/** Cheia i18n (namespace `movies`) pentru fiecare motiv care blochează publicarea. */
export const BLOCKER_KEY: Record<LicenseProblem | "no_episodes" | "episodes_not_approved", string> = {
  license_required: "blockerLicenseRequired",
  attribution_required: "blockerAttributionRequired",
  source_url_required: "blockerSourceUrlRequired",
  territory_required: "blockerTerritoryRequired",
  territory_excludes_service: "blockerTerritoryExcludesService",
  expiry_required: "blockerExpiryRequired",
  license_expired: "blockerLicenseExpired",
  no_episodes: "blockerNoEpisodes",
  episodes_not_approved: "blockerEpisodesNotApproved",
};

export function blockerKey(code: string): string {
  return (BLOCKER_KEY as Record<string, string>)[code] ?? "error";
}
