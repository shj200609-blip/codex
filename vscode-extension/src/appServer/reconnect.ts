// Retry a shared connection only. Never spawn a local fallback or restart Core.
export class SharedReconnect {
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private disposed = false;
  private running = false;
  private pending = false;
  constructor(
    private readonly retry: () => Promise<void>,
    private readonly delays = [1000, 2000, 4000, 8000, 15000],
  ) {}
  disconnected(): void {
    if (this.disposed || this.timer) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    const delay = this.delays[Math.min(this.attempt++, this.delays.length - 1)];
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) return;
      this.running = true;
      void this.retry()
        .catch(() => {
          this.pending = true;
        })
        .finally(() => {
          this.running = false;
          if (this.pending && !this.disposed) {
            this.pending = false;
            this.disconnected();
          }
        });
    }, delay);
  }
  connected(): void {
    this.cancel();
    this.attempt = 0;
  }
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
  }
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
