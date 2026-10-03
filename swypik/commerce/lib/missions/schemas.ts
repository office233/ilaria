import { z } from "zod";
import { missionLimits } from "./config";

export const UUID = z.string().uuid();

/** Creare misiune (seller sau admin). Codurile de eroare sunt stabile (UI le traduce). */
export function missionCreateSchema() {
  const l = missionLimits();
  return z
    .object({
      title: z.string().trim().min(5).max(120),
      brief: z.string().trim().min(20).max(2000),
      formatHint: z.string().trim().max(60).optional().nullable(),
      productId: UUID.optional().nullable(),
      prizeCents: z.number().int().min(l.minPrizeCents).max(l.maxPrizeCents),
      maxWinners: z.number().int().min(1).max(l.maxWinners),
      durationDays: z.number().int().min(l.minDurationDays).max(l.maxDurationDays),
    })
    .strict();
}
export type MissionCreateInput = z.infer<ReturnType<typeof missionCreateSchema>>;

export const judgeActionSchema = z
  .object({
    action: z.enum(["winner", "reject", "pay"]),
    reason: z.string().trim().max(300).optional().nullable(),
  })
  .strict();
export type JudgeAction = z.infer<typeof judgeActionSchema>;

export const missionSubmitSchema = z.object({ videoId: UUID }).strict();

/** `missionId` acceptat de API-ul de metadate video (null = scoate clipul din misiune). */
export const videoMissionFieldSchema = UUID.nullable();

/** Slug stabil din titlu + sufix aleator scurt (unicitate). */
export function missionSlug(title: string, suffix: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "misiune"}-${suffix}`;
}
