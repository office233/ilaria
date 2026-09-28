import { describe, expect, it } from "vitest";
import { addDays, nightsBetween, nightsCount, occupiedNights, rangesOverlap, validateStayRange } from "@/lib/stays/dates";
import {
    canReview,
    guestCanCancel,
    hostClawbackCents,
    isBlocking,
    perNightCents,
    refundFor,
    splitCommission,
    stayTotalCents,
} from "@/lib/stays/policy";
import { isSelectable, monthGrid, nextRange, rangeIsFree } from "@/lib/stays/range-select";

describe("stays dates", () => {
    it("counts nights as a half-open interval", () => {
        expect(nightsCount("2026-10-01", "2026-10-04")).toBe(3);
        expect(nightsBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    });

    it("treats back-to-back stays as NOT overlapping", () => {
        expect(rangesOverlap("2026-10-01", "2026-10-03", "2026-10-03", "2026-10-05")).toBe(false);
        expect(rangesOverlap("2026-10-01", "2026-10-04", "2026-10-03", "2026-10-05")).toBe(true);
        expect(rangesOverlap("2026-10-02", "2026-10-03", "2026-10-01", "2026-10-05")).toBe(true);
    });

    it("validates ranges: order, past dates, max length, bad input", () => {
        const opts = { today: "2026-10-01", maxNights: 30 };
        expect(validateStayRange("2026-10-02", "2026-10-05", opts)).toBeNull();
        expect(validateStayRange("2026-10-05", "2026-10-05", opts)).toBe("invalid_dates");
        expect(validateStayRange("2026-09-30", "2026-10-02", opts)).toBe("past_dates");
        expect(validateStayRange("2026-10-02", "2026-12-02", opts)).toBe("too_long");
        expect(validateStayRange("2026-02-30", "2026-03-02", opts)).toBe("invalid_dates");
    });

    it("builds the occupied-nights set from booked ranges", () => {
        const s = occupiedNights([{ check_in: "2026-10-01", check_out: "2026-10-03" }]);
        expect([...s]).toEqual(["2026-10-01", "2026-10-02"]);
    });
});

describe("stays money policy", () => {
    it("uses price_cents first and falls back to legacy lei attribute", () => {
        expect(perNightCents({ price_cents: 25000 })).toBe(25000);
        expect(perNightCents({ price_cents: null, vertical_attributes: { price_per_night: 199.5 } })).toBe(19950);
        expect(perNightCents({ price_cents: 0, vertical_attributes: {} })).toBe(0);
    });

    it("prices nights with per-day overrides", () => {
        const nights = ["2026-10-01", "2026-10-02", "2026-10-03"];
        expect(stayTotalCents(nights, 10000, new Map([["2026-10-02", 15000]]))).toBe(35000);
    });

    it("splits commission and host net", () => {
        expect(splitCommission(10000, 10)).toEqual({ commissionCents: 1000, hostNetCents: 9000 });
    });

    it("refunds 100% early, late % later, 100% when the host cancels", () => {
        const base = { totalCents: 20000, freeDays: 5, latePct: 50 };
        const now = new Date("2026-10-01T10:00:00Z");
        expect(refundFor({ ...base, checkIn: "2026-10-10", now, by: "guest" })).toEqual({ refundPct: 100, refundCents: 20000 });
        expect(refundFor({ ...base, checkIn: "2026-10-03", now, by: "guest" })).toEqual({ refundPct: 50, refundCents: 10000 });
        expect(refundFor({ ...base, checkIn: "2026-10-03", now, by: "host" })).toEqual({ refundPct: 100, refundCents: 20000 });
    });

    it("claws back only the refunded share of the host net", () => {
        expect(hostClawbackCents(20000, 20000, 10)).toBe(18000);
        expect(hostClawbackCents(20000, 10000, 10)).toBe(9000);
        expect(hostClawbackCents(20000, 0, 10)).toBe(0);
    });
});

describe("stays lifecycle predicates", () => {
    const now = new Date("2026-10-01T10:00:00Z");
    it("expired pending holds stop blocking the calendar", () => {
        expect(isBlocking("pending", "2026-10-01T10:05:00Z", now)).toBe(true);
        expect(isBlocking("pending", "2026-10-01T09:59:00Z", now)).toBe(false);
        expect(isBlocking("requested", null, now)).toBe(true);
        expect(isBlocking("confirmed", null, now)).toBe(true);
        expect(isBlocking("expired", null, now)).toBe(false);
        expect(isBlocking("declined", null, now)).toBe(false);
    });

    it("guests cancel only before check-in and only active bookings", () => {
        expect(guestCanCancel("confirmed", "2026-10-05", "2026-10-01")).toBe(true);
        expect(guestCanCancel("confirmed", "2026-10-01", "2026-10-01")).toBe(false);
        expect(guestCanCancel("completed", "2026-10-05", "2026-10-01")).toBe(false);
    });

    it("reviews are allowed after check-out within the window", () => {
        const w = { windowDays: 30 };
        expect(canReview({ ...w, status: "completed", checkOut: "2026-09-20", today: "2026-10-01" })).toBe(true);
        expect(canReview({ ...w, status: "confirmed", checkOut: "2026-10-03", today: "2026-10-01" })).toBe(false);
        expect(canReview({ ...w, status: "cancelled", checkOut: "2026-09-20", today: "2026-10-01" })).toBe(false);
        expect(canReview({ ...w, status: "completed", checkOut: "2026-08-01", today: "2026-10-01" })).toBe(false);
    });
});

describe("calendar range selection", () => {
    const occupied = new Set(["2026-10-05", "2026-10-06"]);
    it("selects check-in then check-out, refusing ranges over booked nights", () => {
        let r = nextRange({ checkIn: null, checkOut: null }, "2026-10-02", occupied, 30);
        expect(r).toEqual({ checkIn: "2026-10-02", checkOut: null });
        // check-out on the first booked night is fine (someone checks in that day)
        expect(nextRange(r, "2026-10-05", occupied, 30)).toEqual({ checkIn: "2026-10-02", checkOut: "2026-10-05" });
        // spanning booked nights restarts from the tapped day (occupied → cleared)
        expect(nextRange(r, "2026-10-08", occupied, 30)).toEqual({ checkIn: "2026-10-08", checkOut: null });
        r = { checkIn: "2026-10-02", checkOut: "2026-10-04" };
        expect(nextRange(r, "2026-10-06", occupied, 30)).toEqual({ checkIn: null, checkOut: null });
    });

    it("only lets booked nights be tapped as a valid check-out", () => {
        expect(isSelectable({ checkIn: null, checkOut: null }, "2026-10-05", "2026-10-01", occupied, 30)).toBe(false);
        expect(isSelectable({ checkIn: "2026-10-03", checkOut: null }, "2026-10-05", "2026-10-01", occupied, 30)).toBe(true);
        expect(isSelectable({ checkIn: "2026-10-03", checkOut: null }, "2026-10-06", "2026-10-01", occupied, 30)).toBe(false);
        expect(isSelectable({ checkIn: null, checkOut: null }, "2026-09-30", "2026-10-01", occupied, 30)).toBe(false);
        expect(rangeIsFree("2026-10-01", "2026-10-05", occupied)).toBe(true);
    });

    it("lays months out Monday-first", () => {
        const { offset, days } = monthGrid(2026, 9); // octombrie 2026 începe joi
        expect(offset).toBe(3);
        expect(days).toHaveLength(31);
        expect(days[0]).toBe("2026-10-01");
    });
});
