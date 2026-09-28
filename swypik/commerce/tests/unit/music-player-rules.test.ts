import { describe, it, expect } from "vitest";
import {
  lockedAfterAdvance,
  nextTrackIndex,
  buildShuffleOrder,
} from "@/lib/music/player-rules";

const locked = { trackId: "t2" };

describe("music/player-rules lockedAfterAdvance", () => {
  it("cand player-ul sare peste o piesa blocata (402), paywall-ul ramane vizibil", () => {
    expect(lockedAfterAdvance(locked, "locked")).toBe(locked);
  });
  it("o actiune a userului sau trecerea normala la piesa urmatoare inchide paywall-ul", () => {
    expect(lockedAfterAdvance(locked, "user")).toBeNull();
    expect(lockedAfterAdvance(locked, "ended")).toBeNull();
    expect(lockedAfterAdvance(locked, "error")).toBeNull();
    expect(lockedAfterAdvance(null, "locked")).toBeNull();
  });
});

describe("music/player-rules nextTrackIndex", () => {
  it("coada goala nu are piesa urmatoare", () => {
    expect(
      nextTrackIndex({ queueLength: 0, currentIndex: 0, direction: "forward", naturalEnd: true, shuffle: false, repeat: "off", shuffleOrder: [] })
    ).toBeNull();
  });

  it("secvential, fara repeat: avanseaza normal si se opreste la finalul cozii", () => {
    const base = { shuffle: false, repeat: "off" as const, shuffleOrder: [] };
    expect(nextTrackIndex({ ...base, queueLength: 3, currentIndex: 0, direction: "forward", naturalEnd: true })).toBe(1);
    expect(nextTrackIndex({ ...base, queueLength: 3, currentIndex: 2, direction: "forward", naturalEnd: true })).toBeNull();
  });

  it("repeat all: reia coada de la capat in ambele directii", () => {
    const base = { shuffle: false, repeat: "all" as const, shuffleOrder: [] };
    expect(nextTrackIndex({ ...base, queueLength: 3, currentIndex: 2, direction: "forward", naturalEnd: true })).toBe(0);
    expect(nextTrackIndex({ ...base, queueLength: 3, currentIndex: 0, direction: "backward", naturalEnd: false })).toBe(2);
  });

  it("repeat one reia aceeasi piesa DOAR la finalul natural, nu la next()/prev() explicit", () => {
    const base = { queueLength: 3, currentIndex: 1, shuffle: false, repeat: "one" as const, shuffleOrder: [] };
    expect(nextTrackIndex({ ...base, direction: "forward", naturalEnd: true })).toBe(1);
    expect(nextTrackIndex({ ...base, direction: "forward", naturalEnd: false })).toBe(2);
    expect(nextTrackIndex({ ...base, direction: "backward", naturalEnd: false })).toBe(0);
  });

  it("shuffle: urmeaza ordinea data de shuffleOrder, nu indexul secvential", () => {
    const shuffleOrder = [2, 0, 1];
    const base = { queueLength: 3, shuffle: true, repeat: "off" as const, shuffleOrder };
    expect(nextTrackIndex({ ...base, currentIndex: 2, direction: "forward", naturalEnd: true })).toBe(0);
    expect(nextTrackIndex({ ...base, currentIndex: 0, direction: "forward", naturalEnd: true })).toBe(1);
    expect(nextTrackIndex({ ...base, currentIndex: 1, direction: "forward", naturalEnd: true })).toBeNull();
    expect(nextTrackIndex({ ...base, currentIndex: 0, direction: "backward", naturalEnd: false })).toBe(2);
  });

  it("shuffle + repeat all: reia ordinea shuffle de la capat", () => {
    const shuffleOrder = [2, 0, 1];
    expect(
      nextTrackIndex({ queueLength: 3, currentIndex: 1, direction: "forward", naturalEnd: true, shuffle: true, repeat: "all", shuffleOrder })
    ).toBe(2);
  });

  it("shuffleOrder invalid (lungime gresita) cade in mod sigur pe secvential", () => {
    expect(
      nextTrackIndex({ queueLength: 3, currentIndex: 0, direction: "forward", naturalEnd: true, shuffle: true, repeat: "off", shuffleOrder: [0, 1] })
    ).toBe(1);
  });
});

describe("music/player-rules buildShuffleOrder", () => {
  it("e o permutare a [0..length-1]", () => {
    const order = buildShuffleOrder(6, () => 0.5);
    expect(order.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("lungime 0 sau 1 e stabila", () => {
    expect(buildShuffleOrder(0)).toEqual([]);
    expect(buildShuffleOrder(1)).toEqual([0]);
  });
});
