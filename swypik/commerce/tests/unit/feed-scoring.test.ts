import { describe, expect, it } from "vitest";
import {
    DEFAULT_FEED_WEIGHTS,
    freshnessSignal,
    scoreVideo,
    type FeedWeights,
    type VideoScoringInput,
} from "@/lib/algo/scoring";

const W: FeedWeights = { ...DEFAULT_FEED_WEIGHTS };

function input(over: Partial<VideoScoringInput> = {}): VideoScoringInput {
    return {
        ageHours: 10,
        engagementRate: 0.05,
        conversionRate: 0,
        viewerFollowsCreator: false,
        creatorServedToViewerToday: 0,
        creatorFollowers: 5000,
        creatorViewsToday: 0,
        ...over,
    };
}

describe("freshnessSignal", () => {
    it("is maximal at publication and decays", () => {
        expect(freshnessSignal(0)).toBeCloseTo(5, 5);
        expect(freshnessSignal(24)).toBeLessThan(freshnessSignal(0));
        expect(freshnessSignal(24)).toBeCloseTo(2.5, 1); // half-life ~24h
        expect(freshnessSignal(240)).toBeLessThan(0.02);
    });

    it("clamps invalid input", () => {
        expect(freshnessSignal(-5)).toBe(0);
        expect(freshnessSignal(Number.NaN)).toBe(0);
    });
});

describe("scoreVideo — echitate", () => {
    it("clip nou de la creator mic bate clip vechi de la creator mare", () => {
        const small = scoreVideo(
            input({ ageHours: 6, creatorFollowers: 120, engagementRate: 0.04 }),
            W,
        );
        const big = scoreVideo(
            input({ ageHours: 400, creatorFollowers: 500_000, engagementRate: 0.08 }),
            W,
        );
        expect(small.parts.smallCreatorBoost).toBe(W.small_creator_boost);
        expect(big.parts.smallCreatorBoost).toBe(0);
        expect(small.score).toBeGreaterThan(big.score);
    });

    it("nu acorda boost creatorului mic daca clipul e mai vechi de 48h", () => {
        const fresh = scoreVideo(input({ ageHours: 47, creatorFollowers: 100 }), W);
        const stale = scoreVideo(input({ ageHours: 49, creatorFollowers: 100 }), W);
        expect(fresh.parts.smallCreatorBoost).toBe(W.small_creator_boost);
        expect(stale.parts.smallCreatorBoost).toBe(0);
    });

    it("nu acorda boost creatorului mare chiar daca clipul e proaspat", () => {
        const big = scoreVideo(input({ ageHours: 1, creatorFollowers: 1000 }), W);
        expect(big.parts.smallCreatorBoost).toBe(0);
    });

    it("saturatia penalizeaza progresiv acelasi creator (rotatie)", () => {
        const first = scoreVideo(input({ creatorServedToViewerToday: 0 }), W);
        const second = scoreVideo(input({ creatorServedToViewerToday: 1 }), W);
        const third = scoreVideo(input({ creatorServedToViewerToday: 3 }), W);
        expect(second.score).toBeLessThan(first.score);
        expect(third.score).toBeLessThan(second.score);
        expect(third.parts.saturation).toBe(3 * W.rotation_penalty);
    });

    it("plafonul de vizualizari/zi retrogradeaza clipurile creatorului", () => {
        const under = scoreVideo(input({ creatorViewsToday: W.daily_views_cap }), W);
        const over = scoreVideo(input({ creatorViewsToday: W.daily_views_cap + 1 }), W);
        expect(under.parts.dailyCapPenalty).toBe(0);
        expect(over.parts.dailyCapPenalty).toBe(W.daily_cap_penalty);
        expect(over.score).toBeCloseTo(under.score - W.daily_cap_penalty, 6);
    });

    it("un creator mare peste plafon pierde in fata unui creator mic proaspat", () => {
        const dominator = scoreVideo(
            input({
                ageHours: 2,
                engagementRate: 0.5,
                conversionRate: 0.05,
                creatorFollowers: 900_000,
                creatorViewsToday: W.daily_views_cap * 2,
                creatorServedToViewerToday: 3,
            }),
            W,
        );
        const newcomer = scoreVideo(
            input({ ageHours: 5, engagementRate: 0.02, creatorFollowers: 50 }),
            W,
        );
        expect(newcomer.score).toBeGreaterThan(dominator.score);
    });
});

describe("scoreVideo — semnale de baza", () => {
    it("bonusul de follow creste scorul cu w_follow_bonus", () => {
        const notFollowing = scoreVideo(input({ viewerFollowsCreator: false }), W);
        const following = scoreVideo(input({ viewerFollowsCreator: true }), W);
        expect(following.score - notFollowing.score).toBeCloseTo(W.w_follow_bonus, 6);
    });

    it("conversion_rate mai mare => scor mai mare", () => {
        const low = scoreVideo(input({ conversionRate: 0.001 }), W);
        const high = scoreVideo(input({ conversionRate: 0.05 }), W);
        expect(high.score).toBeGreaterThan(low.score);
    });

    it("engagementul este comprimat logaritmic (nu domina la infinit)", () => {
        // Aceeasi crestere absoluta (+0.5) valoreaza mult mai putin la rate mari.
        const a = scoreVideo(input({ engagementRate: 0.1 }), W);
        const b = scoreVideo(input({ engagementRate: 0.6 }), W);
        const c = scoreVideo(input({ engagementRate: 10 }), W);
        const d = scoreVideo(input({ engagementRate: 10.5 }), W);
        expect(b.score - a.score).toBeGreaterThan(d.score - c.score);
    });

    it("valorile negative sunt tratate ca 0", () => {
        const neg = scoreVideo(input({ engagementRate: -5, conversionRate: -1 }), W);
        const zero = scoreVideo(input({ engagementRate: 0, conversionRate: 0 }), W);
        expect(neg.score).toBeCloseTo(zero.score, 6);
    });
});
