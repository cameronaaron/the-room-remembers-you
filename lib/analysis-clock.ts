/** Keep the target cadence despite timer quantization, without catch-up bursts. */
export class AnalysisClock {
  private nextAt = 0;
  private interval = 0;
  due(now: number, intervalMs: number): boolean {
    if (this.interval !== intervalMs) {
      this.interval = intervalMs;
      this.nextAt = now;
    }
    if (now < this.nextAt) return false;
    const next = this.nextAt + intervalMs;
    this.nextAt = next <= now ? now + intervalMs : next;
    return true;
  }
}
