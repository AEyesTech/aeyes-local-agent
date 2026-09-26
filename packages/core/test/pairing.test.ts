import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config.js';
import { hashToken, PAIR_CODE_TTL_MS, PAIR_LOCK_MS, PairingManager } from '../src/security/pairing.js';

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'aeyes-pair-'));
  const store = await ConfigStore.open(path.join(home, '.a'), home);
  let now = 1_000_000;
  const manager = new PairingManager(store, () => now);
  return { store, manager, advance: (ms: number) => { now += ms; } };
}

const labels = { accountLabel: 'ky***@gmail.com', browserLabel: 'Chrome' };

describe('PairingManager', () => {
  it('6자리 코드로 토큰을 발급하고 해시만 저장한다', async () => {
    const { store, manager } = await setup();
    const { code } = manager.createCode();
    expect(code).toMatch(/^\d{6}$/);
    const result = await manager.redeem({ code, ...labels });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const saved = store.get().pairings;
    expect(saved).toHaveLength(1);
    expect(saved[0].tokenHash).toBe(hashToken(result.token));
    expect(JSON.stringify(saved)).not.toContain(result.token);
    expect(manager.verify(result.token)?.id).toBe(saved[0].id);
    expect(manager.verify('wrong')).toBeNull();
  });

  it('코드는 1회용', async () => {
    const { manager } = await setup();
    const { code } = manager.createCode();
    expect((await manager.redeem({ code, ...labels })).ok).toBe(true);
    expect(await manager.redeem({ code, ...labels })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('5분이 지나면 expired', async () => {
    const { manager, advance } = await setup();
    const { code } = manager.createCode();
    advance(PAIR_CODE_TTL_MS + 1);
    expect(await manager.redeem({ code, ...labels })).toEqual({ ok: false, reason: 'expired' });
  });

  it('5회 실패하면 10분 잠금(맞는 코드도 거부)', async () => {
    const { manager, advance } = await setup();
    const { code } = manager.createCode();
    for (let i = 0; i < 5; i += 1) await manager.redeem({ code: '000000' === code ? '111111' : '000000', ...labels });
    expect(await manager.redeem({ code, ...labels })).toEqual({ ok: false, reason: 'locked' });
    advance(PAIR_LOCK_MS + 1);
    const fresh = manager.createCode();
    expect((await manager.redeem({ code: fresh.code, ...labels })).ok).toBe(true);
  });

  it('라벨은 80자로 자른다', async () => {
    const { manager, store } = await setup();
    const { code } = manager.createCode();
    await manager.redeem({ code, accountLabel: 'a'.repeat(200), browserLabel: 'b' });
    expect(store.get().pairings[0].accountLabel).toHaveLength(80);
  });

  it('revoke 와 revokeAll', async () => {
    const { manager } = await setup();
    const a = await manager.redeem({ code: manager.createCode().code, ...labels });
    const b = await manager.redeem({ code: manager.createCode().code, ...labels });
    if (!a.ok || !b.ok) throw new Error('pairing failed');
    expect(await manager.revoke(a.record.id)).toBe(true);
    expect(manager.verify(a.token)).toBeNull();
    expect(manager.verify(b.token)).not.toBeNull();
    expect(await manager.revokeAll()).toBe(1);
    expect(manager.verify(b.token)).toBeNull();
  });
});
