const SLUG_MAX_LENGTH = 70;

/** Slug unic pentru un serial: kebab-case ASCII din titlu + sufix de timp (base36). */
export function slugifySeriesTitle(title: string): string {
    const base = title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, SLUG_MAX_LENGTH);
    return `${base || "serial"}-${Date.now().toString(36)}`;
}
