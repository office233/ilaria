/**
 * Licențele titlurilor Swypik Movies — reguli pure, fără DB.
 *
 * Un titlu nu se publică fără metadate de licență complete: tipul licenței,
 * atribuirea (obligatorie la CC BY / CC BY-SA / distribuitor), sursa (URL
 * https, obligatorie la tot ce nu e producție proprie), teritoriile (trebuie
 * să acopere teritoriul serviciului) și expirarea (obligatorie la distribuitor,
 * mereu în viitor). Aceleași reguli sunt dublate în DB de trigger-ul din
 * migrarea 20260926_0040 (fără verificarea teritoriului, care depinde de env).
 */
import { z } from "zod";

export const LICENSE_TYPES = ["cc_by", "cc_by_sa", "public_domain", "owned", "distributor"] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

/** Cheia i18n (namespace `movies`) a fiecărui tip de licență. */
export const LICENSE_LABEL_KEY = {
    cc_by: "licenseCcBy",
    cc_by_sa: "licenseCcBySa",
    public_domain: "licensePublicDomain",
    owned: "licenseOwned",
    distributor: "licenseDistributor",
} as const satisfies Record<LicenseType, string>;

export const TITLE_FORMATS = ["series", "film"] as const;
export type TitleFormat = (typeof TITLE_FORMATS)[number];

/** Teritorii speciale acceptate pe lângă codurile ISO 3166-1 alpha-2. */
export const TERRITORY_WORLD = "WORLD";
export const TERRITORY_EU = "EU";

/** Statele membre UE (ISO alpha-2) — pentru a decide dacă „EU" acoperă teritoriul serviciului. */
const EU_MEMBERS = new Set([
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
    "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

const TERRITORY_RE = /^(WORLD|EU|[A-Z]{2})$/;
const ATTRIBUTION_MAX = 2000;
const URL_MAX = 500;
const TERRITORIES_MAX = 60;

/** Tipurile pentru care textul de atribuire e obligatoriu (CC BY cere credit complet). */
const ATTRIBUTION_REQUIRED: ReadonlySet<LicenseType> = new Set(["cc_by", "cc_by_sa", "distributor"]);
/** Tipurile pentru care sursa (pagina licenței / contractul) e obligatorie. */
const SOURCE_REQUIRED: ReadonlySet<LicenseType> = new Set(["cc_by", "cc_by_sa", "public_domain", "distributor"]);
/** Tipurile care cer dată de expirare (licențele de distribuție sunt pe termen). */
const EXPIRY_REQUIRED: ReadonlySet<LicenseType> = new Set(["distributor"]);

export const httpsUrl = z
    .string()
    .trim()
    .max(URL_MAX)
    .url()
    .refine((u) => u.startsWith("https://"), { message: "https_required" });

export const LicenseInputSchema = z.object({
    type: z.enum(LICENSE_TYPES),
    attributionText: z.string().trim().max(ATTRIBUTION_MAX).nullable().default(null),
    sourceUrl: httpsUrl.nullable().default(null),
    territories: z
        .array(z.string().trim().toUpperCase().regex(TERRITORY_RE))
        .max(TERRITORIES_MAX)
        .default([])
        .transform((list) => Array.from(new Set(list))),
    expiresAt: z.coerce.date().nullable().default(null),
});
export type LicenseInput = z.infer<typeof LicenseInputSchema>;

/** Ce e stocat pe `movie_series` (coloanele de licență). */
export type SeriesLicense = {
    license_type: LicenseType | null;
    attribution_text: string | null;
    license_source_url: string | null;
    license_territories: string[];
    license_expires_at: string | Date | null;
};

export type LicenseProblem =
    | "license_required"
    | "attribution_required"
    | "source_url_required"
    | "territory_required"
    | "territory_excludes_service"
    | "expiry_required"
    | "license_expired";

/** Teritoriul în care rulează serviciul (implicit România). */
export function serviceTerritory(): string {
    return (process.env.MOVIES_SERVICE_TERRITORY || "RO").trim().toUpperCase();
}

export function territoriesCover(territories: readonly string[], target: string): boolean {
    const t = target.toUpperCase();
    return territories.some((x) => x === TERRITORY_WORLD || x === t || (x === TERRITORY_EU && EU_MEMBERS.has(t)));
}

function toTime(v: string | Date | null): number | null {
    if (v === null) return null;
    const ms = v instanceof Date ? v.getTime() : Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
}

/** Licența e expirată acum? (fără dată = nu expiră). */
export function isLicenseExpired(expiresAt: string | Date | null, now: number = Date.now()): boolean {
    const ms = toTime(expiresAt);
    return ms !== null && ms <= now;
}

/**
 * Toate problemele care împiedică publicarea. Listă goală = publicabil.
 * Funcție pură: primește teritoriul serviciului și momentul curent explicit.
 */
export function licenseProblems(
    lic: SeriesLicense,
    opts: { territory?: string; now?: number } = {},
): LicenseProblem[] {
    const territory = opts.territory ?? serviceTerritory();
    const now = opts.now ?? Date.now();
    const type = lic.license_type;
    if (!type) return ["license_required"];
    const problems: LicenseProblem[] = [];
    if (ATTRIBUTION_REQUIRED.has(type) && !lic.attribution_text?.trim()) problems.push("attribution_required");
    if (SOURCE_REQUIRED.has(type) && !lic.license_source_url?.trim()) problems.push("source_url_required");
    if (lic.license_territories.length === 0) problems.push("territory_required");
    else if (!territoriesCover(lic.license_territories, territory)) problems.push("territory_excludes_service");
    if (EXPIRY_REQUIRED.has(type) && lic.license_expires_at === null) problems.push("expiry_required");
    if (isLicenseExpired(lic.license_expires_at, now)) problems.push("license_expired");
    return problems;
}

/** Coloanele DB din inputul validat (pentru INSERT/UPDATE). */
export function licenseColumns(input: LicenseInput): SeriesLicense {
    return {
        license_type: input.type,
        attribution_text: input.attributionText,
        license_source_url: input.sourceUrl,
        license_territories: input.territories,
        license_expires_at: input.expiresAt,
    };
}

/** Atribuirea arătată public pe pagina titlului (null dacă nu e nimic de arătat). */
export type PublicAttribution = {
    licenseType: LicenseType;
    text: string | null;
    sourceUrl: string | null;
};

export function publicAttribution(lic: SeriesLicense): PublicAttribution | null {
    if (!lic.license_type) return null;
    if (lic.license_type === "owned" && !lic.attribution_text) return null;
    return { licenseType: lic.license_type, text: lic.attribution_text, sourceUrl: lic.license_source_url };
}
