/**
 * Un singur AudioContext deblocat la primul gest al utilizatorului — iOS
 * WebView / Safari blochează sunetul pornit fără gest (audit food-go #21:
 * alertele de ofertă nouă / comandă nouă erau mute pe iPhone).
 *
 * `armAlertAudio()` se cheamă o dată la montarea panoului (șofer / restaurant);
 * primul tap/click creează și „resume" contextul, iar `playTones()` îl refolosește.
 */
type Tone = { start: number; freq: number; duration: number; gain?: number };

let ctx: AudioContext | null = null;
let armed = false;

function audioCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

function unlock(): void {
  const Ctx = audioCtor();
  if (!Ctx) return;
  try {
    if (!ctx) ctx = new Ctx();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    // Un buffer mut pornit în gest „deblochează" definitiv contextul pe iOS.
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* audio indisponibil */
  }
}

export function armAlertAudio(): () => void {
  if (typeof window === "undefined" || armed) return () => undefined;
  armed = true;
  const events = ["pointerdown", "touchend", "keydown"] as const;
  const handler = () => unlock();
  events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
  return () => {
    events.forEach((e) => window.removeEventListener(e, handler));
    armed = false;
  };
}

export function alertAudioReady(): boolean {
  return Boolean(ctx && ctx.state === "running");
}

export function playTones(tones: readonly Tone[]): void {
  if (!ctx) unlock(); // desktop: merge și fără gest
  const c = ctx;
  if (!c) return;
  try {
    if (c.state === "suspended") void c.resume().catch(() => undefined);
    for (const tone of tones) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = tone.freq;
      const peak = tone.gain ?? 0.4;
      gain.gain.setValueAtTime(0.001, c.currentTime + tone.start);
      gain.gain.exponentialRampToValueAtTime(peak, c.currentTime + tone.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + tone.start + tone.duration);
      osc.connect(gain).connect(c.destination);
      osc.start(c.currentTime + tone.start);
      osc.stop(c.currentTime + tone.start + tone.duration + 0.05);
    }
  } catch {
    /* audio indisponibil */
  }
}
