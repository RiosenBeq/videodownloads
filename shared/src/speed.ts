/**
 * Download speed estimator over a sliding time window, robust to bursty
 * progress updates (segment downloads, chunked writes).
 */
export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(private readonly windowMs = 5000) {}

  /** Record the cumulative byte count at time `now` (ms). */
  push(totalBytes: number, now = Date.now()): void {
    this.samples.push({ t: now, bytes: totalBytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  /** Bytes per second, or undefined until there is enough data. */
  speed(): number | undefined {
    if (this.samples.length < 2) return undefined;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.25) return undefined;
    return Math.max(0, (last.bytes - first.bytes) / dt);
  }

  eta(totalBytes: number | undefined, doneBytes: number): number | undefined {
    const speed = this.speed();
    if (!totalBytes || !speed || speed <= 0 || doneBytes >= totalBytes) return undefined;
    return (totalBytes - doneBytes) / speed;
  }

  reset(): void {
    this.samples = [];
  }
}
