const SLUG_MAX_LENGTH = 70;

export type MusicSlugKind = "track" | "album" | "artist";

/** Slug unic: kebab-case ASCII din text + sufix de timp (base36); fallback pe tipul entității. */
export function slugifyMusic(text: string, kind: MusicSlugKind): string {
    const base = text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, SLUG_MAX_LENGTH);
    return `${base || kind}-${Date.now().toString(36)}`;
}
