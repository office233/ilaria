export type HapticPattern = "tap" | "success" | "warning";

export function haptic(pattern: HapticPattern = "tap"): void {
  if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
  const map: Record<HapticPattern, number | number[]> = {
    tap: 10,
    success: [10, 30, 10],
    warning: [30, 50, 30],
  };
  try {
    navigator.vibrate(map[pattern]);
  } catch {}
}
