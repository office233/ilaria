/**
 * Code 128 (ISO/IEC 15417) — encoder pur, fără dependențe.
 *
 * Întoarce lățimile modulelor (bară, spațiu, bară, …) gata de desenat în SVG
 * sau PDF. Folosit pe eticheta AWB: codul trebuie să poată fi scanat de curier,
 * nu „bare decorative”. Numerele doar cu cifre (lungime pară ≥ 4) folosesc
 * setul C (mai compact); restul, setul B (ASCII 32–126).
 */

/** Tabelul standard de lățimi (bară/spațiu alternativ), valorile 0–106. */
const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_B = 104;
const START_C = 105;
const STOP = 106;

export class BarcodeInputError extends Error {
  constructor() {
    super("barcode_invalid_input");
  }
}

/** Exportat pentru teste: tabelul trebuie să aibă 107 intrări de câte 11 module (STOP: 13). */
export const CODE128_PATTERNS = PATTERNS;

function prefersSetC(value: string): boolean {
  return value.length >= 4 && value.length % 2 === 0 && /^\d+$/.test(value);
}

/** Valorile de simbol (start + date + checksum + stop). */
export function code128Symbols(value: string): number[] {
  if (!value || value.length > 80) throw new BarcodeInputError();
  const data: number[] = [];
  let start: number;
  if (prefersSetC(value)) {
    start = START_C;
    for (let i = 0; i < value.length; i += 2) data.push(Number(value.slice(i, i + 2)));
  } else {
    start = START_B;
    for (const ch of value) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code > 126) throw new BarcodeInputError();
      data.push(code - 32);
    }
  }
  let checksum = start;
  data.forEach((v, i) => {
    checksum += v * (i + 1);
  });
  return [start, ...data, checksum % 103, STOP];
}

/** Lățimile modulelor, alternând bară/spațiu, începând cu o bară. */
export function code128Modules(value: string): number[] {
  return code128Symbols(value).flatMap((s) => PATTERNS[s].split("").map(Number));
}

export type BarRect = { x: number; width: number };

/**
 * Barele ca dreptunghiuri, în unități de modul, cu zona liniștită (10 module)
 * inclusă în `totalModules`.
 */
export function code128Bars(value: string, quietZone = 10): { bars: BarRect[]; totalModules: number } {
  const modules = code128Modules(value);
  const bars: BarRect[] = [];
  let x = quietZone;
  modules.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, width: w });
    x += w;
  });
  return { bars, totalModules: x + quietZone };
}
