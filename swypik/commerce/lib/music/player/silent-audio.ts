/**
 * Un clip WAV mut, foarte scurt, ca data URI. Îl redăm sincron în handler-ul de click
 * când URL-ul real vine abia după un fetch (piese Swypik cu token): iOS Safari
 * „deblochează" astfel elementul `<audio>`, iar `play()`-ul de după `await` nu mai e respins.
 */

const SAMPLE_RATE = 8_000;
const SAMPLE_COUNT = 800; // 0,1 s

function writeAscii(view: DataView, offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function buildSilentWavBytes(sampleCount: number = SAMPLE_COUNT, sampleRate: number = SAMPLE_RATE): Uint8Array {
    const header = 44;
    const buffer = new ArrayBuffer(header + sampleCount);
    const view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + sampleCount, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true); // mărimea chunk-ului fmt (PCM)
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true); // byte rate = rate * 1 canal * 1 octet
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // biți / eșantion
    writeAscii(view, 36, "data");
    view.setUint32(40, sampleCount, true);
    new Uint8Array(buffer, header).fill(0x80); // 8-bit PCM: 128 = liniște
    return new Uint8Array(buffer);
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

let cached: string | null = null;

export function silentWavDataUri(): string {
    if (!cached) cached = `data:audio/wav;base64,${toBase64(buildSilentWavBytes())}`;
    return cached;
}

export function isSilentPrimerSrc(src: string | null | undefined): boolean {
    return Boolean(src) && src === silentWavDataUri();
}
