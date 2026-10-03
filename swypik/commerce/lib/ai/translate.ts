/**
 * Helperi pentru segmentele de subtitrare. (Traducerea automată a subtitrărilor
 * prin GitHub Models nu avea niciun apelant și a fost scoasă odată cu furnizorul.)
 */
import type { CaptionSegment } from "./transcribe";

export function segmentsToText(segs: CaptionSegment[]): string {
  return segs.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
}
