import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — script .mjs fără declarații de tip
import { HEX_RE, SMALL_TEXT_RE, countMatches } from "../../scripts/scan-design-debt.mjs";
import { themeColorFor, THEME_COLORS } from "@/lib/theme/theme-color";
import { immersiveStore } from "@/lib/theme/immersive-store";
import { initialsOf } from "@/lib/ui/initials";
import { cn } from "@/lib/ui/cn";
import { cartCountFrom, formatBadgeCount, unreadCountFrom } from "@/lib/nav/useShellCounts";

describe("scan-design-debt", () => {
  it("numără culori hex, nu ancore sau entități HTML", () => {
    const src = `className="bg-[#7C3AED] text-[#fff]" href="#main-content" x="&#123;" color: #0D0D0D80; id="#faq"`;
    expect(countMatches(src, HEX_RE)).toBe(3);
  });
  it("numără text sub 12px", () => {
    expect(countMatches("text-[10px] text-[11px] text-[12px] text-[9.5px] text-xs", SMALL_TEXT_RE)).toBe(3);
  });
});

describe("tokens", () => {
  const css = readFileSync(resolve(__dirname, "../../app/styles/tokens.css"), "utf8");
  it("definește aceleași culori pentru light și dark", () => {
    const light = css.slice(css.indexOf(':root,'), css.indexOf('[data-theme="dark"]'));
    const dark = css.slice(css.indexOf('[data-theme="dark"]'), css.indexOf(":root {", css.indexOf('[data-theme="dark"]')));
    const names = (block: string) => [...block.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).sort();
    expect(names(dark)).toEqual(names(light));
    expect(names(light)).toEqual(expect.arrayContaining(["canvas", "surface", "fg", "fg-muted", "border", "brand", "danger"]));
  });
  it("nu conține hex (canale RGB pentru opacitate Tailwind)", () => {
    expect(countMatches(css, HEX_RE)).toBe(0);
  });
});

describe("theme color", () => {
  it("negru pe suprafețe imersive, altfel după tema rezolvată", () => {
    expect(themeColorFor("light", true)).toBe(THEME_COLORS.immersive);
    expect(themeColorFor("dark", false)).toBe(THEME_COLORS.dark);
    expect(themeColorFor(undefined, false)).toBe(THEME_COLORS.light);
  });
  it("immersiveStore numără intrările și ieșirile (idempotent)", () => {
    expect(immersiveStore.getSnapshot()).toBe(false);
    const leaveA = immersiveStore.enter();
    const leaveB = immersiveStore.enter();
    leaveA();
    leaveA();
    expect(immersiveStore.getSnapshot()).toBe(true);
    leaveB();
    expect(immersiveStore.getSnapshot()).toBe(false);
  });
});

describe("ui helpers", () => {
  it("initialsOf", () => {
    expect(initialsOf("Ana Maria Pop")).toBe("AP");
    expect(initialsOf("ștefan")).toBe("Ș");
    expect(initialsOf("  ")).toBe("?");
  });
  it("cn rezolvă conflictele, inclusiv clasele custom", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("shadow-elev-1", "shadow-elev-3")).toBe("shadow-elev-3");
    expect(cn("rounded-card", "rounded-sheet")).toBe("rounded-sheet");
    expect(cn("text-muted", "text-fg")).toBe("text-fg");
  });
  it("contoare shell", () => {
    expect(cartCountFrom({ items: [{ quantity: 2 }, { quantity: "3" }] })).toBe(5);
    expect(cartCountFrom(null)).toBe(0);
    expect(unreadCountFrom({ unreadCount: 2 }, { conversations: [{ unread_count: 3 }, { unread_count: 0 }] })).toBe(3);
    expect(unreadCountFrom(null, [{ unread_count: 1 }])).toBe(1);
    expect(formatBadgeCount(0)).toBeNull();
    expect(formatBadgeCount(120)).toBe("99+");
  });
});
