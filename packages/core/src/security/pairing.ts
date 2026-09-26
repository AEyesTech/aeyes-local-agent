/**
 * 6자리 코드 페어링. 코드는 메모리에만 있고(5분·1회용), 발급 토큰은 SHA-256 해시만 설정에 저장한다.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ConfigStore, PairingRecord } from '../config.js';

export const PAIR_CODE_TTL_MS = 5 * 60_000;
export const PAIR_MAX_FAILURES = 5;
export const PAIR_LOCK_MS = 10 * 60_000;
const LABEL_MAX = 80;
const TOUCH_INTERVAL_MS = 5 * 60_000;

export type RedeemResult =
  | { ok: true; token: string; record: PairingRecord }
  | { ok: false; reason: 'locked' | 'invalid' | 'expired' };

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class PairingManager {
  private code: { value: string; expiresAt: number } | null = null;
  private failures = 0;
  private lockedUntil = 0;

  constructor(private readonly store: ConfigStore, private readonly now: () => number = Date.now) {}

  createCode(): { code: string; expiresAt: number } {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.now() + PAIR_CODE_TTL_MS;
    this.code = { value, expiresAt };
    return { code: value, expiresAt };
  }

  async redeem(input: { code: string; accountLabel: string; browserLabel: string }): Promise<RedeemResult> {
    const t = this.now();
    if (t < this.lockedUntil) return { ok: false, reason: 'locked' };
    const current = this.code;
    if (!current) return this.fail(t, 'invalid');
    if (t > current.expiresAt) {
      this.code = null;
      return this.fail(t, 'expired');
    }
    if (!safeEqual(String(input.code ?? ''), current.value)) return this.fail(t, 'invalid');

    this.code = null;
    this.failures = 0;
    const token = randomBytes(32).toString('base64url');
    const record: PairingRecord = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      accountLabel: String(input.accountLabel ?? '').slice(0, LABEL_MAX),
      browserLabel: String(input.browserLabel ?? '').slice(0, LABEL_MAX),
      createdAt: new Date(t).toISOString(),
      lastUsedAt: null,
    };
    await this.store.update((c) => { c.pairings.push(record); });
    return { ok: true, token, record };
  }

  verify(token: string): PairingRecord | null {
    if (!token) return null;
    const hash = hashToken(token);
    return this.store.get().pairings.find((p) => safeEqual(p.tokenHash, hash)) ?? null;
  }

  async revoke(id: string): Promise<boolean> {
    let removed = false;
    await this.store.update((c) => {
      const before = c.pairings.length;
      c.pairings = c.pairings.filter((p) => p.id !== id);
      removed = c.pairings.length < before;
    });
    return removed;
  }

  async revokeAll(): Promise<number> {
    let count = 0;
    await this.store.update((c) => {
      count = c.pairings.length;
      c.pairings = [];
    });
    return count;
  }

  /** 마지막 사용 시각 갱신(쓰기 증폭을 피해 5분 간격). */
  async touch(id: string): Promise<void> {
    const t = this.now();
    const record = this.store.get().pairings.find((p) => p.id === id);
    if (!record) return;
    if (record.lastUsedAt && t - Date.parse(record.lastUsedAt) < TOUCH_INTERVAL_MS) return;
    await this.store.update((c) => {
      const target = c.pairings.find((p) => p.id === id);
      if (target) target.lastUsedAt = new Date(t).toISOString();
    });
  }

  private fail(t: number, reason: 'invalid' | 'expired'): RedeemResult {
    this.failures += 1;
    if (this.failures >= PAIR_MAX_FAILURES) {
      this.failures = 0;
      this.lockedUntil = t + PAIR_LOCK_MS;
      this.code = null;
    }
    return { ok: false, reason };
  }
}
