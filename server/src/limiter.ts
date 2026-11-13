/**
 * In-memory sliding-window limiter. Fine for one instance; with several
 * instances this moves to Redis (INCR + EXPIRE) without changing callers.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {
    setInterval(() => this.sweep(), windowMs).unref();
  }

  /** Records a hit. Returns 0 if allowed, otherwise milliseconds until the next allowed hit. */
  hit(key: string, max = this.max): number {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      return this.windowMs - (now - list[0]!);
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, list] of this.hits) {
      if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}
