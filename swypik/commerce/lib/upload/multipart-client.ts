/**
 * Urcarea reală, reluabilă, a unui fișier video în părți S3 (browser).
 *
 * - progres pe octeți (XHR upload.onprogress pe fiecare parte), nu estimat;
 * - reluare: întreabă serverul ce părți există deja (ListParts) și le sare;
 * - retry cu backoff exponențial + jitter pe fiecare parte; offline → așteaptă
 *   evenimentul `online` fără să consume încercări;
 * - anulare: AbortSignal oprește toate cererile în zbor.
 * Dependențele (semnare, listare, PUT) sunt injectabile pentru teste.
 */
import { VIDEO_LIMITS } from "@/lib/video/limits";

export type PartUrl = { partNumber: number; url: string };

export type MultipartDeps = {
  signParts: (partNumbers: number[]) => Promise<PartUrl[]>;
  listParts: () => Promise<Array<{ partNumber: number; size: number }>>;
  putPart: (url: string, body: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  waitOnline?: (signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

export type MultipartOptions = {
  file: Blob;
  partSize: number;
  totalParts: number;
  signal: AbortSignal;
  onProgress: (loadedBytes: number, totalBytes: number) => void;
  concurrency?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
};

export class PartUploadError extends Error {
  status: number;
  constructor(status: number) {
    super(`part_upload_failed_${status}`);
    this.name = "PartUploadError";
    this.status = status;
  }
}

export function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

/** Întârzierea înainte de încercarea `attempt` (1-based), cu jitter ±25%. */
export function retryDelayMs(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, 30_000);
  return Math.round(capped * (0.75 + random() * 0.5));
}

/** Erorile care nu merită reîncercate (clientul nu are drept / sesiunea s-a închis). */
export function isFatalStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 404 || status === 409 || status === 410 || status === 413;
}

export function partRange(partNumber: number, partSize: number, fileSize: number): [number, number] {
  const start = (partNumber - 1) * partSize;
  return [start, Math.min(fileSize, start + partSize)];
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(abortError())), { once: true });
  });

const defaultWaitOnline = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (typeof navigator === "undefined" || navigator.onLine) return resolve();
    const done = () => (window.removeEventListener("online", done), resolve());
    window.addEventListener("online", done);
    signal.addEventListener("abort", () => (window.removeEventListener("online", done), reject(abortError())), { once: true });
  });

export async function uploadMultipart(opts: MultipartOptions, deps: MultipartDeps): Promise<void> {
  const { file, partSize, totalParts, signal } = opts;
  const concurrency = opts.concurrency ?? VIDEO_LIMITS.uploadConcurrency;
  const maxAttempts = opts.maxAttempts ?? VIDEO_LIMITS.partMaxAttempts;
  const baseMs = opts.retryBaseMs ?? VIDEO_LIMITS.partRetryBaseMs;
  const sleep = deps.sleep ?? defaultSleep;
  const waitOnline = deps.waitOnline ?? defaultWaitOnline;

  const done = new Map<number, number>();
  for (const p of await deps.listParts()) {
    const [s, e] = partRange(p.partNumber, partSize, file.size);
    if (p.size === e - s) done.set(p.partNumber, p.size);
  }
  const inflight = new Map<number, number>();
  const report = () => {
    let loaded = 0;
    done.forEach((v) => (loaded += v));
    inflight.forEach((v) => (loaded += v));
    opts.onProgress(Math.min(loaded, file.size), file.size);
  };
  report();

  const queue: number[] = [];
  for (let n = 1; n <= totalParts; n += 1) if (!done.has(n)) queue.push(n);
  const urls = new Map<number, string>();

  async function urlFor(partNumber: number, refresh: boolean): Promise<string> {
    if (!refresh && urls.has(partNumber)) return urls.get(partNumber) as string;
    const batch = [partNumber, ...queue.filter((n) => !urls.has(n) && n !== partNumber)].slice(
      0,
      VIDEO_LIMITS.maxPartUrlsPerRequest,
    );
    for (const p of await deps.signParts(batch)) urls.set(p.partNumber, p.url);
    const url = urls.get(partNumber);
    if (!url) throw new PartUploadError(500);
    return url;
  }

  async function uploadOne(partNumber: number): Promise<void> {
    const [start, end] = partRange(partNumber, partSize, file.size);
    const body = file.slice(start, end);
    let refresh = false;
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) throw abortError();
      await waitOnline(signal);
      try {
        const url = await urlFor(partNumber, refresh);
        await deps.putPart(url, body, signal, (loaded) => {
          inflight.set(partNumber, loaded);
          report();
        });
        inflight.delete(partNumber);
        done.set(partNumber, end - start);
        report();
        return;
      } catch (err) {
        inflight.delete(partNumber);
        report();
        if (signal.aborted || (err as { name?: string }).name === "AbortError") throw abortError();
        const status = err instanceof PartUploadError ? err.status : 0;
        if (isFatalStatus(status) || attempt >= maxAttempts) throw err;
        // 403 = URL presemnat expirat (sesiune lungă) → semnăm din nou.
        refresh = status === 403;
        await sleep(retryDelayMs(attempt, baseMs, deps.random), signal);
      }
    }
  }

  async function worker(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await uploadOne(next);
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
}

/** PUT prin XHR (fetch nu raportează progresul de upload). */
export function xhrPutPart(url: string, body: Blob, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (ev) => onProgress(ev.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new PartUploadError(xhr.status)));
    xhr.onerror = () => reject(new PartUploadError(0));
    xhr.ontimeout = () => reject(new PartUploadError(0));
    xhr.onabort = () => reject(abortError());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
