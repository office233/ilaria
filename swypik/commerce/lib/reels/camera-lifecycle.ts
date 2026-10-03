/** Ownership guard for getUserMedia, which cannot be cancelled while prompting. */
type StoppableStream = { getTracks(): Array<{ stop(): void }> };

export class CameraRequestLifecycle<T extends StoppableStream> {
  private active = false;
  private generation = 0;
  private pending = false;
  private stream: T | null = null;

  activate(): void {
    this.active = true;
  }

  get isPending(): boolean {
    return this.pending;
  }

  begin(): number | null {
    if (!this.active || this.pending) return null;
    this.pending = true;
    return ++this.generation;
  }

  isCurrent(request: number): boolean {
    return this.active && request === this.generation;
  }

  accept(request: number, stream: T): boolean {
    if (!this.isCurrent(request)) {
      this.stop(stream);
      return false;
    }
    this.pending = false;
    this.release();
    this.stream = stream;
    return true;
  }

  reject(request: number): boolean {
    if (!this.isCurrent(request)) return false;
    this.pending = false;
    return true;
  }

  release(): void {
    if (this.stream) this.stop(this.stream);
    this.stream = null;
  }

  dispose(): void {
    this.active = false;
    ++this.generation;
    this.pending = false;
    this.release();
  }

  private stop(stream: T): void {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* Continue releasing other tracks. */ }
    }
  }
}
