/**
 * Swypik Synthetic Web Audio SFX Engine
 * 
 * Generează efecte sonore tactile și dopaminergice folosind Web Audio API (fără fișiere MP3 externe).
 * Zero dependențe, latență 0ms, compatibil cu toate browserele moderne și mobile.
 */

let audioCtx: AudioContext | null = null;
let isMuted = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

export function isAudioMuted(): boolean {
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem("swypik_sfx_muted");
    if (stored !== null) return stored === "true";
  }
  return isMuted;
}

export function setAudioMuted(muted: boolean): void {
  isMuted = muted;
  if (typeof window !== "undefined") {
    localStorage.setItem("swypik_sfx_muted", String(muted));
  }
}

export function toggleAudioMute(): boolean {
  const next = !isAudioMuted();
  setAudioMuted(next);
  return next;
}

/**
 * Sunet de Casă de Marcat ("Ka-Ching")
 * Clink metalic + armonică strălucitoare la finalizarea comenzii
 */
export function playCashRegisterSound(): void {
  if (isAudioMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Ton 1: Ding clink (B5 ~ 987 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(987.77, now);
    osc1.frequency.exponentialRampToValueAtTime(1318.51, now + 0.08); // E6
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Ton 2: Shimmering "Ching" armonic (E6 ~ 1318 Hz și G#6 ~ 1661 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(1318.51, now + 0.07);
    osc2.frequency.setValueAtTime(1661.22, now + 0.12);
    osc2.frequency.setValueAtTime(2093.00, now + 0.18); // C7 strălucitor
    gain2.gain.setValueAtTime(0.001, now);
    gain2.gain.setValueAtTime(0.25, now + 0.07);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.07);
    osc2.stop(now + 0.6);
  } catch {
    // Ignoră erorile audio silențios
  }
}

/**
 * Sunet Mystery Box Unbox
 * Sweep ascendent misterios urmat de acord triumfător
 */
export function playMysteryUnboxSound(): void {
  if (isAudioMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Sweep ascendent misterios
    const oscSweep = ctx.createOscillator();
    const gainSweep = ctx.createGain();
    oscSweep.type = "sawtooth";
    oscSweep.frequency.setValueAtTime(220, now);
    oscSweep.frequency.exponentialRampToValueAtTime(880, now + 0.25);
    gainSweep.gain.setValueAtTime(0.15, now);
    gainSweep.gain.exponentialRampToValueAtTime(0.01, now + 0.25);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(600, now);
    filter.frequency.linearRampToValueAtTime(2400, now + 0.25);

    oscSweep.connect(filter);
    filter.connect(gainSweep);
    gainSweep.connect(ctx.destination);
    oscSweep.start(now);
    oscSweep.stop(now + 0.25);

    // Chime exploziv de bucurie (C6, E6, G6)
    const notes = [1046.5, 1318.51, 1567.98];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + 0.25 + idx * 0.04);
      gain.gain.setValueAtTime(0.22, now + 0.25 + idx * 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8 + idx * 0.04);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + 0.25 + idx * 0.04);
      osc.stop(now + 0.8 + idx * 0.04);
    });
  } catch {
    // Ignoră
  }
}

/**
 * Fanfară Victorie / Revendicare
 */
export function playVictorySound(): void {
  if (isAudioMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    // 4 note ascendente: F4, A4, C5, F5
    const chord = [349.23, 440.0, 523.25, 698.46];
    chord.forEach((freq, i) => {
      const noteTime = now + i * 0.1;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, noteTime);

      const duration = i === chord.length - 1 ? 0.6 : 0.15;
      gain.gain.setValueAtTime(0.2, noteTime);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(noteTime);
      osc.stop(noteTime + duration);
    });
  } catch {
    // Ignoră
  }
}

/**
 * Click / Pop haptic subtil
 */
export function playPopSound(): void {
  if (isAudioMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(650, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.06);

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  } catch {
    // Ignoră
  }
}
