import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isAudioMuted,
  setAudioMuted,
  toggleAudioMute,
  playCashRegisterSound,
  playMysteryUnboxSound,
  playVictorySound,
  playPopSound,
} from "@/lib/audio/sfx";

describe("Swypik Synthetic Web Audio SFX Engine", () => {
  beforeEach(() => {
    setAudioMuted(false);
  });

  it("handles mute states correctly", () => {
    expect(isAudioMuted()).toBe(false);

    setAudioMuted(true);
    expect(isAudioMuted()).toBe(true);

    const toggled = toggleAudioMute();
    expect(toggled).toBe(false);
    expect(isAudioMuted()).toBe(false);
  });

  it("executes sound functions safely without throwing in node environment", () => {
    // In node environment, window is undefined or mock
    expect(() => playCashRegisterSound()).not.toThrow();
    expect(() => playMysteryUnboxSound()).not.toThrow();
    expect(() => playVictorySound()).not.toThrow();
    expect(() => playPopSound()).not.toThrow();
  });

  it("silences all sound functions when muted", () => {
    setAudioMuted(true);
    expect(() => {
      playCashRegisterSound();
      playMysteryUnboxSound();
      playVictorySound();
      playPopSound();
    }).not.toThrow();
  });
});
