/**
 * Validarea ingestului de titluri Movies (admin). Pur — fără DB/rețea.
 *
 * Un titlu intră în catalog DOAR cu metadate de licență: tipul licenței e
 * obligatoriu încă de la creare (nu se poate crea un titlu „fără licență"),
 * iar restul regulilor (atribuire, sursă, teritoriu, expirare) blochează
 * publicarea până sunt complete — vezi `licenseProblems`.
 */
import { z } from "zod";
import { LOCALES } from "@/lib/i18n/config";
import { MOVIE_GENRES } from "./genres";
import { httpsUrl, LicenseInputSchema, licenseColumns, licenseProblems, TITLE_FORMATS, type LicenseProblem } from "./license";
import { MOVIES_DEFAULT_FREE_EPISODES, MOVIES_MAX_FREE_EPISODES } from "./config";

const TITLE_MIN = 2;
const TITLE_MAX = 120;
const SYNOPSIS_MAX = 2000;
const EPISODE_TITLE_MAX = 120;
const MAX_EPISODE_NUMBER = 500;

export const IngestTitleSchema = z.object({
    title: z.string().trim().min(TITLE_MIN).max(TITLE_MAX),
    synopsis: z.string().trim().max(SYNOPSIS_MAX).default(""),
    format: z.enum(TITLE_FORMATS).default("film"),
    genres: z.array(z.enum(MOVIE_GENRES)).max(5).default([]),
    languageCode: z.enum(LOCALES).default("ro"),
    posterUrl: httpsUrl.nullable().default(null),
    coverUrl: httpsUrl.nullable().default(null),
    freeEpisodes: z.coerce.number().int().min(0).max(MOVIES_MAX_FREE_EPISODES).default(MOVIES_DEFAULT_FREE_EPISODES),
    /** null = gratuit / fără preț (conținut CC și domeniu public rămâne de regulă gratuit). */
    episodePriceCents: z.coerce.number().int().positive().nullable().default(null),
    isAdult: z.boolean().default(false),
    license: LicenseInputSchema,
    /** Fișierul video (https) importat prin pipeline-ul de transcodare ca episodul 1. */
    mediaUrl: httpsUrl.nullable().default(null),
});
export type IngestTitleInput = z.infer<typeof IngestTitleSchema>;

export const LicensePatchSchema = z.object({ license: LicenseInputSchema });

export const IngestEpisodeSchema = z
    .object({
        title: z.string().trim().min(1).max(EPISODE_TITLE_MAX),
        episodeNumber: z.coerce.number().int().min(1).max(MAX_EPISODE_NUMBER).optional(),
        /** Un video existent (gata, aprobat)… */
        videoId: z.string().uuid().optional(),
        /** …sau un fișier https de importat prin pipeline. */
        mediaUrl: httpsUrl.optional(),
    })
    .refine((v) => Boolean(v.videoId) !== Boolean(v.mediaUrl), { message: "video_or_media_url" });
export type IngestEpisodeInput = z.infer<typeof IngestEpisodeSchema>;

export type IngestValidation =
    | { ok: true; data: IngestTitleInput; publishBlockers: LicenseProblem[] }
    | { ok: false; error: string };

/**
 * Validează corpul cererii. `publishBlockers` spune adminului ce mai lipsește
 * până la publicare (titlul se poate salva ca ciornă și incomplet).
 */
export function validateIngest(body: unknown, opts: { territory?: string; now?: number } = {}): IngestValidation {
    const parsed = IngestTitleSchema.safeParse(body);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, error: issue ? `${issue.path.join(".") || "body"}:${issue.message}` : "invalid_body" };
    }
    return { ok: true, data: parsed.data, publishBlockers: licenseProblems(licenseColumns(parsed.data.license), opts) };
}
