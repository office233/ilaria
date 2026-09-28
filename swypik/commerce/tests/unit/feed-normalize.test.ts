import { describe, expect, it } from "vitest";
import { normalizeSocialFeedProducts } from "@/lib/chat/feed-normalize";

const VIDEO_ID = "33333333-3333-4333-8333-333333333333";
const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";

/**
 * Regresie pentru bug-ul care rupea like-urile pe feed-ul din homepage
 * (audit 2026-08-24): `/api/v1/feed` livra produsul fără `video_id`, iar
 * ProductFeed cădea pe id-ul produsului și trimitea POST
 * /api/videos/{uuid-de-produs}/like → 404, cu revert silențios pe gri.
 * Contractul verificat aici: dacă item-ul are un video_id, el ajunge pe
 * produsul normalizat.
 */
describe("normalizeSocialFeedProducts — propagarea video_id", () => {
    const item = (extra: Record<string, unknown> = {}) => ({
        video_id: VIDEO_ID,
        product: { id: PRODUCT_ID, title: "Lampă LED", price: 99 },
        ...extra,
    });

    it("păstrează video_id-ul de pe item pe produsul normalizat", () => {
        const [product] = normalizeSocialFeedProducts({ items: [item()] });
        expect(product.video_id).toBe(VIDEO_ID);
        expect(product.videoId).toBe(VIDEO_ID);
    });

    it("acceptă și forma camelCase venită de pe alte suprafețe", () => {
        const [product] = normalizeSocialFeedProducts({
            items: [{ videoId: VIDEO_ID, product: { id: PRODUCT_ID, title: "Lampă LED", price: 99 } }],
        });
        expect(product.video_id).toBe(VIDEO_ID);
    });

    it("citește video_id-ul și când e pus pe obiectul produs, nu pe item", () => {
        const [product] = normalizeSocialFeedProducts({
            items: [{ product: { id: PRODUCT_ID, title: "Lampă LED", price: 99, video_id: VIDEO_ID } }],
        });
        expect(product.video_id).toBe(VIDEO_ID);
    });

    it("lasă video_id nedefinit când feed-ul chiar nu are clip — butonul de like nu se randează", () => {
        const [product] = normalizeSocialFeedProducts({
            items: [{ product: { id: PRODUCT_ID, title: "Lampă LED", price: 99 } }],
        });
        expect(product.video_id).toBeUndefined();
        // Important: NU cade pe id-ul produsului, care ar produce 404 la like.
        expect(product.video_id).not.toBe(PRODUCT_ID);
    });

    it("nu confundă id-ul produsului cu cel al clipului", () => {
        const [product] = normalizeSocialFeedProducts({ items: [item()] });
        expect(product.video_id).not.toBe(product.id);
    });

    it("ignoră item-urile fără titlu (produse incomplete)", () => {
        const products = normalizeSocialFeedProducts({
            items: [item(), { video_id: VIDEO_ID, product: { id: PRODUCT_ID } }],
        });
        expect(products).toHaveLength(1);
    });
});
