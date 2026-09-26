import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/security/rateLimit.js';

describe('RateLimiter', () => {
  it('창 안에서 limit 을 넘으면 거부하고 다음 창에서 초기화', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    expect([limiter.allow('a'), limiter.allow('a'), limiter.allow('a'), limiter.allow('a')]).toEqual([true, true, true, false]);
    expect(limiter.allow('b')).toBe(true);
    now = 1000;
    expect(limiter.allow('a')).toBe(true);
  });
});
