/**
 * Taxonomia fixă de genuri Swypik Music. Etichetele sunt în messages/*.json sub
 * `music.genre_<id>`; filtrele, rândurile paginii și selectoarele din studio
 * folosesc doar aceste id-uri.
 */
export const MUSIC_GENRES = ["pop", "hiphop", "trap", "manele", "rock", "electronic", "rnb", "latino", "folk", "kids"] as const;

export type MusicGenre = (typeof MUSIC_GENRES)[number];

export function isMusicGenre(value: unknown): value is MusicGenre {
    return typeof value === "string" && (MUSIC_GENRES as readonly string[]).includes(value);
}

/** Cheia de traducere din namespace-ul `music` pentru un gen. */
export function musicGenreLabelKey(genre: MusicGenre): `genre_${MusicGenre}` {
    return `genre_${genre}`;
}

/** Păstrează doar genurile cunoscute, fără duplicate, în ordinea primită (case-insensitive). */
export function normalizeMusicGenres(input: readonly string[]): MusicGenre[] {
    const out: MusicGenre[] = [];
    for (const raw of input) {
        const g = raw.trim().toLowerCase();
        if (isMusicGenre(g) && !out.includes(g)) out.push(g);
    }
    return out;
}
