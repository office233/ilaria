/**
 * Draft local al fluxului de creare (per viewer, best-effort):
 * - detaliile formularului, salvate automat pe clip (localStorage);
 * - uploadurile în curs + fișierul (IndexedDB) ca să poată fi reluate după
 *   reîncărcarea paginii sau pierderea conexiunii.
 * Draftul „oficial” e rândul din DB (visibility='draft'); acesta doar evită
 * pierderea textului tastat înainte de salvare.
 */
import { deleteBlob, loadBlob, saveBlob } from "@/lib/upload/blob-store";

export type DetailsDraft = {
  title: string;
  description: string;
  productId: string | null;
  productTitle: string | null;
  productOverlaySec: number;
  /** Misiunea (uuid) la care se înscrie clipul; null = niciuna. */
  missionId: string | null;
  audioTrackId: number | null;
  audioTrackLabel: string | null;
  /** Mixul sunetului ales (procente 0..200; vezi lib/video/sound-mix.ts). */
  soundVolume: number;
  soundOriginalVolume: number;
  soundKeepOriginal: boolean;
  soundLoop: boolean;
  allowComments: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  captionsEnabled: boolean;
};

export type ActiveUpload = {
  sessionId: string;
  videoId: string;
  name: string;
  size: number;
  savedAt: number;
};

const DETAILS_PREFIX = "swypik:create:details:";
const ACTIVE_KEY = "swypik:create:active";
const MAX_ACTIVE = 5;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* cotă depășită / mod privat — draftul local e opțional */
  }
}

export const detailsDraft = {
  load: (videoId: string) => read<DetailsDraft>(DETAILS_PREFIX + videoId),
  save: (videoId: string, draft: DetailsDraft) => write(DETAILS_PREFIX + videoId, draft),
  clear: (videoId: string) => {
    try {
      storage()?.removeItem(DETAILS_PREFIX + videoId);
    } catch {
      /* ignore */
    }
  },
};

export const activeUploads = {
  list: (): ActiveUpload[] => read<ActiveUpload[]>(ACTIVE_KEY) ?? [],
  async remember(entry: ActiveUpload, file: Blob): Promise<void> {
    const rest = activeUploads.list().filter((u) => u.sessionId !== entry.sessionId);
    write(ACTIVE_KEY, [entry, ...rest].slice(0, MAX_ACTIVE));
    await saveBlob(entry.sessionId, file).catch(() => undefined);
  },
  async forget(sessionId: string): Promise<void> {
    write(
      ACTIVE_KEY,
      activeUploads.list().filter((u) => u.sessionId !== sessionId),
    );
    await deleteBlob(sessionId).catch(() => undefined);
  },
  file: (sessionId: string): Promise<Blob | null> => loadBlob(sessionId).catch(() => null),
};
