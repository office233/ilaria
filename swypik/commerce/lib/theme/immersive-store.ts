/**
 * Contor global de suprafețe imersive montate (<ImmersiveSurface>). Când e > 0,
 * bara de sistem devine neagră și BottomNav trece pe varianta întunecată.
 * Store minimal compatibil cu useSyncExternalStore.
 */
type Listener = () => void;

let count = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const immersiveStore = {
  enter(): () => void {
    count += 1;
    emit();
    let left = false;
    return () => {
      if (left) return;
      left = true;
      count = Math.max(0, count - 1);
      emit();
    };
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): boolean {
    return count > 0;
  },
  getServerSnapshot(): boolean {
    return false;
  },
};
