/**
 * Reguli pure ale player-ului (testabile fără React).
 *
 * De ce avansăm în coadă: `locked` = piesa curentă a răspuns 402 și sărim
 * peste ea — paywall-ul trebuie să rămână vizibil ca userul să poată debloca;
 * orice altă cauză (acțiunea userului, sfârșitul piesei, eroare) îl închide.
 */
export type AdvanceReason = "user" | "locked" | "ended" | "error";

export function lockedAfterAdvance<L>(previous: L | null, reason: AdvanceReason): L | null {
    return reason === "locked" ? previous : null;
}

/** Modurile de repetare ale coadei: off (fără), all (reia coada), one (reia piesa curentă). */
export type RepeatMode = "off" | "all" | "one";

export type NextTrackParams = {
    queueLength: number;
    currentIndex: number;
    direction: "forward" | "backward";
    /** true doar când piesa s-a terminat singură (natural) — repeat "one" acționează doar aici. */
    naturalEnd: boolean;
    shuffle: boolean;
    repeat: RepeatMode;
    /** Permutare a indicilor [0..queueLength-1] folosită doar cât shuffle e activ. */
    shuffleOrder: readonly number[];
};

/**
 * Calculează indexul următoarei piese din coadă, pur funcție de starea
 * player-ului — fără randomness și fără efecte secundare (randomness-ul trăiește
 * în `buildShuffleOrder`, apelat separat de fiecare dată când coada sau
 * shuffle-ul se schimbă).
 *
 * Întoarce `null` când nu mai există piesă următoare (coadă epuizată, fără
 * repeat "all").
 */
export function nextTrackIndex(params: NextTrackParams): number | null {
    const { queueLength, currentIndex, direction, naturalEnd, shuffle, repeat, shuffleOrder } = params;
    if (queueLength <= 0) return null;

    if (repeat === "one" && naturalEnd) return currentIndex;

    const step = direction === "forward" ? 1 : -1;

    if (shuffle && shuffleOrder.length === queueLength) {
        const pos = shuffleOrder.indexOf(currentIndex);
        if (pos !== -1) {
            const nextPos = pos + step;
            if (nextPos >= 0 && nextPos < shuffleOrder.length) return shuffleOrder[nextPos];
            if (repeat === "all") {
                return direction === "forward" ? shuffleOrder[0] : shuffleOrder[shuffleOrder.length - 1];
            }
            return null;
        }
    }

    const next = currentIndex + step;
    if (next >= 0 && next < queueLength) return next;
    if (repeat === "all") return direction === "forward" ? 0 : queueLength - 1;
    return null;
}

/** Fisher–Yates peste indicii [0..length-1] — ordinea de redare cât shuffle e activ. */
export function buildShuffleOrder(length: number, rng: () => number = Math.random): number[] {
    const order = Array.from({ length }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}
