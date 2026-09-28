import { describe, it, expect } from "vitest";
import { triggerConfetti } from "@/lib/confetti";

describe("Swypik Confetti Launcher", () => {
  it("runs safely in non-browser environment without throwing", () => {
    expect(() => triggerConfetti()).not.toThrow();
  });
});
