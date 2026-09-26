/** 고정 창 요청 제한. 키(토큰 해시 등)별로 windowMs 동안 limit 건까지 허용한다. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const current = this.windows.get(key);
    if (!current || t - current.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 1000) this.prune(t);
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private prune(t: number): void {
    for (const [key, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(key);
  }
}
