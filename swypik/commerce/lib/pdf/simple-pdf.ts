/**
 * Generator PDF minimal (PDF 1.4), fără dependențe — pentru documentele
 * sellerului generate pe server (factură, bon POS, etichetă AWB).
 *
 * De ce pe server: `window.print()` și `<a download>` cu blob nu fac nimic în
 * WebView-ul Capacitor al aplicației. Un PDF servit cu Content-Disposition se
 * poate deschide în browserul sistemului / foaia de partajare și tipări de acolo.
 *
 * Fonturi: Helvetica / Helvetica-Bold standard (fără încorporare), codare
 * WinAnsi. Diacriticele românești care nu există în WinAnsi (ă, ș, ț) sunt
 * transliterate — documentul rămâne lizibil fără fișiere de font în repo.
 * Coordonatele API-ului sunt de sus-stânga, în puncte (1/72 inch).
 */

export type PdfFont = "regular" | "bold";
export type TextOptions = { size?: number; font?: PdfFont; align?: "left" | "right" | "center"; gray?: number };

/** Lățimile Helvetica (AFM, 1/1000 em) pentru ASCII 32–126. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
  500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469,
  556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Caractere în afara Latin-1 care au totuși un cod WinAnsi. */
const WIN_ANSI_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "™": 0x99,
};

/** Diacritice românești fără cod WinAnsi. */
const TRANSLIT: Record<string, string> = {
  "ă": "a", "Ă": "A", "ș": "s", "Ș": "S", "ş": "s", "Ş": "S", "ț": "t", "Ț": "T", "ţ": "t", "Ţ": "T",
  "\u202f": " ", "\u2009": " ",
};

/** Text Unicode → coduri WinAnsi (un octet per caracter). */
export function toWinAnsi(input: string): number[] {
  const out: number[] = [];
  for (const raw of input) {
    const ch = TRANSLIT[raw] ?? raw;
    for (const c of ch) {
      const code = c.codePointAt(0) ?? 63;
      if ((code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff)) out.push(code);
      else if (WIN_ANSI_EXTRA[c] != null) out.push(WIN_ANSI_EXTRA[c]);
      else {
        const base = c.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const b = base.codePointAt(0) ?? 63;
        out.push(base.length === 1 && b >= 32 && b <= 126 ? b : 63);
      }
    }
  }
  return out;
}

function charWidth(code: number): number {
  if (code >= 32 && code <= 126) return HELVETICA_WIDTHS[code - 32];
  return 556;
}

/** Lățimea textului în puncte (aproximată pentru bold). */
export function textWidth(text: string, size: number, font: PdfFont = "regular"): number {
  const units = toWinAnsi(text).reduce((sum, c) => sum + charWidth(c), 0);
  return (units * size * (font === "bold" ? 1.05 : 1)) / 1000;
}

/** Împarte textul în rânduri care încap în `maxWidth`. */
export function wrapText(text: string, maxWidth: number, size: number, font: PdfFont = "regular"): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, size, font) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function pdfString(text: string): string {
  let s = "(";
  for (const code of toWinAnsi(text)) {
    if (code === 0x28 || code === 0x29 || code === 0x5c) s += `\\${String.fromCharCode(code)}`;
    else if (code < 32 || code > 126) s += `\\${code.toString(8).padStart(3, "0")}`;
    else s += String.fromCharCode(code);
  }
  return `${s})`;
}

function num(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

export class SimplePdf {
  private readonly pages: string[][] = [];

  constructor(
    readonly width = 595.28,
    readonly height = 841.89,
  ) {
    this.addPage();
  }

  addPage(): void {
    this.pages.push([]);
  }

  private get ops(): string[] {
    return this.pages[this.pages.length - 1];
  }

  text(x: number, y: number, text: string, opts: TextOptions = {}): void {
    const size = opts.size ?? 10;
    const font = opts.font ?? "regular";
    let px = x;
    if (opts.align === "right") px = x - textWidth(text, size, font);
    else if (opts.align === "center") px = x - textWidth(text, size, font) / 2;
    const gray = opts.gray ?? 0;
    this.ops.push(
      `BT ${num(gray)} g /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${num(px)} ${num(this.height - y - size)} Td ${pdfString(text)} Tj ET`,
    );
  }

  /** Paragraf cu wrap; întoarce y-ul de sub ultimul rând. */
  paragraph(x: number, y: number, text: string, maxWidth: number, opts: TextOptions = {}): number {
    const size = opts.size ?? 10;
    const lineHeight = size * 1.3;
    let cy = y;
    for (const line of wrapText(text, maxWidth, size, opts.font)) {
      this.text(x, cy, line, opts);
      cy += lineHeight;
    }
    return cy;
  }

  rect(x: number, y: number, w: number, h: number, opts: { fill?: boolean; gray?: number; lineWidth?: number } = {}): void {
    const gray = num(opts.gray ?? 0);
    const box = `${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re`;
    if (opts.fill ?? true) this.ops.push(`${gray} g ${box} f`);
    else this.ops.push(`${gray} G ${num(opts.lineWidth ?? 0.8)} w ${box} S`);
  }

  line(x1: number, y1: number, x2: number, y2: number, lineWidth = 0.6, gray = 0): void {
    this.ops.push(
      `${num(gray)} G ${num(lineWidth)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`,
    );
  }

  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => {
      objects.push(body);
      return objects.length;
    };
    const catalogId = add("");
    const pagesId = add("");
    const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join("\n");
      const contentId = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
            `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
      );
    }
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

/** Desenează un cod Code 128 (module din lib/barcode/code128) în dreptunghiul dat. */
export function drawBars(
  pdf: SimplePdf,
  bars: Array<{ x: number; width: number }>,
  totalModules: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const unit = width / totalModules;
  for (const bar of bars) pdf.rect(x + bar.x * unit, y, bar.width * unit, height);
}
