/**
 * Taxonomia fixă de genuri Swypik Movies. Etichetele sunt în messages/*.json sub
 * `movies.genre_<id>`; filtrele, rândurile din catalog și selectoarele din
 * studio/admin folosesc doar aceste id-uri.
 */
export const MOVIE_GENRES = [
    "drama",
    "romance",
    "comedy",
    "thriller",
    "action",
    "fantasy",
    "kdrama",
    "crime",
    "mystery",
    "family",
] as const;

export type MovieGenre = (typeof MOVIE_GENRES)[number];

export function isMovieGenre(value: unknown): value is MovieGenre {
    return typeof value === "string" && (MOVIE_GENRES as readonly string[]).includes(value);
}

/** Cheia de traducere din namespace-ul `movies` pentru un gen. */
export function genreLabelKey(genre: MovieGenre): `genre_${MovieGenre}` {
    return `genre_${genre}`;
}

/** Păstrează doar genurile cunoscute, fără duplicate, în ordinea primită (case-insensitive). */
export function normalizeGenres(input: readonly string[]): MovieGenre[] {
    const out: MovieGenre[] = [];
    for (const raw of input) {
        const g = raw.trim().toLowerCase();
        if (isMovieGenre(g) && !out.includes(g)) out.push(g);
    }
    return out;
}
