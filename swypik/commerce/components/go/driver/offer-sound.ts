import { playTones } from "../alert-audio";

const OFFER_HZ = 880;

/** Beep scurt dublu (AudioContext partajat, deblocat la primul gest) + vibrație — alertă la ofertă nouă. */
export function alertNewOffer(withSound: boolean): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.([200, 100, 200]);
  if (!withSound) return;
  playTones([
    { start: 0, freq: OFFER_HZ, duration: 0.35 },
    { start: 0.5, freq: OFFER_HZ, duration: 0.35 },
  ]);
}
