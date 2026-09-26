import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../src/config.js';
import { alwaysAllowKey, ConfirmationGate } from '../src/policy/gate.js';
import type { Confirmer } from '../src/policy/confirmer.js';

async function store() {
  const home = await mkdtemp(path.join(tmpdir(), 'aeyes-gate-'));
  return ConfigStore.open(path.join(home, '.a'), home);
}

const base = { tool: 'shell_exec', summary: 'git status', origin: 'https://studio.aeyes.dev', accountLabel: 'a' };

describe('alwaysAllowKey', () => {
  it('셸은 명령 첫 단어, 앱은 이름, 그 외는 도구명', () => {
    expect(alwaysAllowKey('shell_exec', { command: '  Git   status' })).toBe('shell_exec:git');
    expect(alwaysAllowKey('open_app', { name: 'Microsoft Excel' })).toBe('open_app:microsoft excel');
    expect(alwaysAllowKey('fs_delete', { path: 'a' })).toBe('fs_delete');
  });
});

describe('ConfirmationGate', () => {
  it('allow 는 이번만, deny 는 거부', async () => {
    const s = await store();
    const confirmer: Confirmer = { confirm: vi.fn(async () => 'allow' as const) };
    const gate = new ConfirmationGate(s, confirmer);
    expect(await gate.check({ ...base, key: 'shell_exec:git' })).toBe(true);
    expect(await gate.check({ ...base, key: 'shell_exec:git' })).toBe(true);
    expect(confirmer.confirm).toHaveBeenCalledTimes(2);
    const denying = new ConfirmationGate(s, { confirm: async () => 'deny' });
    expect(await denying.check({ ...base, key: 'shell_exec:git' })).toBe(false);
  });

  it('always 는 기록되고 이후 확인을 건너뛴다', async () => {
    const s = await store();
    const confirmer: Confirmer = { confirm: vi.fn(async () => 'always' as const) };
    const gate = new ConfirmationGate(s, confirmer);
    expect(await gate.check({ ...base, key: 'shell_exec:git' })).toBe(true);
    expect(await gate.check({ ...base, key: 'shell_exec:git' })).toBe(true);
    expect(confirmer.confirm).toHaveBeenCalledTimes(1);
    expect(s.get().alwaysAllow.map((r) => r.key)).toEqual(['shell_exec:git']);
  });

  it('타임아웃이면 거부하고 확인기에 중단 신호를 보낸다', async () => {
    const s = await store();
    let aborted = false;
    const confirmer: Confirmer = {
      confirm: (_req, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }),
    };
    const gate = new ConfirmationGate(s, confirmer, 30);
    expect(await gate.check({ ...base, key: 'k' })).toBe(false);
    expect(aborted).toBe(true);
  });

  it('확인기가 throw 하면 거부', async () => {
    const s = await store();
    const gate = new ConfirmationGate(s, { confirm: async () => { throw new Error('ui gone'); } });
    expect(await gate.check({ ...base, key: 'k' })).toBe(false);
  });
});
