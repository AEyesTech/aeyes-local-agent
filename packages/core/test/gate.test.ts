import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../src/config.js';
import { CONFIRM_TIMEOUT_MS, ConfirmationGate, grantKey, InputBlockedError, SESSION_GRANT_TTL_MS, sessionGrantKey } from '../src/policy/gate.js';
import type { ConfirmDecision, Confirmer } from '../src/policy/confirmer.js';

async function store() {
  const home = await mkdtemp(path.join(tmpdir(), 'aeyes-gate-'));
  return ConfigStore.open(path.join(home, '.a'), home);
}

const base = { tool: 'shell_exec', summary: 'git status', origin: 'https://studio.aeyes.dev', accountLabel: 'a' };

describe('grantKey (항상 허용 가능 범위)', () => {
  it('단순 명령은 첫 단어 단위로 허용 가능', () => {
    expect(grantKey('shell_exec', { command: '  Git   status' })).toBe('shell_exec:git');
    expect(grantKey('shell_exec', { command: 'ls -la docs' })).toBe('shell_exec:ls');
  });

  it('셸 제어·치환 문자가 있으면 허용 불가(null)', () => {
    for (const command of [
      'git status; rm -rf ~', 'git status && curl x', 'git log | sh', 'git `id`', 'git $(id)', 'echo $HOME',
      'git status > out.txt', 'git < in', 'git status\nrm -rf ~', 'git status\rrm', 'git status & calc',
      'git (x)', 'git {x}',
    ]) {
      expect(grantKey('shell_exec', { command }), command).toBeNull();
    }
  });

  it('래퍼·인터프리터·환경변수 대입·경로 머리는 허용 불가(null)', () => {
    for (const command of [
      'sudo ls', 'doas ls', 'env ls', 'nohup ls', 'xargs rm', 'time ls', 'nice ls', 'sh x.sh', 'bash x', 'zsh x',
      'dash x', 'fish x', 'powershell x', 'pwsh x', 'cmd /c x', 'cmd.exe /c x', 'node a.js', 'python a.py',
      'python3 a.py', 'Python3.12 a.py', 'perl a', 'ruby a', 'osascript a', 'open a', 'start a', 'rundll32 a',
      'reg add x', 'schtasks /create', 'launchctl load x', 'crontab x', 'BASH.EXE x', 'FOO=1 git status',
      'git -c core.pager=less log', './run.sh', '/usr/bin/sudo ls', 'C:\\tools\\x.exe', 'eval ls', 'exec ls',
      'iex x', 'find . -exec rm {} +', '',
    ]) {
      expect(grantKey('shell_exec', { command }), command).toBeNull();
    }
  });

  it('open_path 는 http(s) URL 만 허용 가능, 파일 경로는 항상 묻는다', () => {
    expect(grantKey('open_path', { target: 'https://studio.aeyes.dev/x' })).toBe('open_path:url');
    expect(grantKey('open_path', { target: 'http://example.com' })).toBe('open_path:url');
    expect(grantKey('open_path', { target: 'a.txt' })).toBeNull();
    expect(grantKey('open_path', { target: '/Users/a/Documents/AeyeStudio/x.pdf' })).toBeNull();
    expect(grantKey('open_path', { target: 'file:///etc/passwd' })).toBeNull();
  });

  it('open_app 은 인자가 없을 때만 앱 이름 단위로 허용 가능', () => {
    expect(grantKey('open_app', { name: 'Microsoft Excel' })).toBe('open_app:microsoft excel');
    expect(grantKey('open_app', { name: 'Microsoft Excel', args: [] })).toBe('open_app:microsoft excel');
    expect(grantKey('open_app', { name: 'Terminal', args: ['-e', 'rm'] })).toBeNull();
  });

  it('그 외 도구는 도구명', () => {
    expect(grantKey('fs_delete', { path: 'a' })).toBe('fs_delete');
  });
});

describe('ConfirmationGate', () => {
  it('허용 불가(key null) 요청은 항상 허용 목록을 보지 않고, always 는 이번만 허용으로 처리', async () => {
    const s = await store();
    await s.update((c) => { c.alwaysAllow.push({ key: 'shell_exec:git', createdAt: 'x' }); });
    const seen: Array<{ alwaysAllowed?: boolean; grantKey?: string }> = [];
    const confirmer: Confirmer = { confirm: vi.fn(async (req) => { seen.push({ alwaysAllowed: req.alwaysAllowed, grantKey: req.grantKey }); return 'always' as const; }) };
    const gate = new ConfirmationGate(s, confirmer);
    expect(await gate.check({ ...base, summary: 'git status; rm -rf ~', key: null })).toBe(true);
    expect(confirmer.confirm).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({ alwaysAllowed: false, grantKey: undefined });
    expect(s.get().alwaysAllow.map((r) => r.key)).toEqual(['shell_exec:git']);
    const denying = new ConfirmationGate(s, { confirm: async () => 'deny' });
    expect(await denying.check({ ...base, summary: 'git status; rm -rf ~', key: null })).toBe(false);
  });

  it('허용 가능 요청은 확인기에 alwaysAllowed 와 범위 키를 넘긴다', async () => {
    const s = await store();
    const seen: Array<{ alwaysAllowed?: boolean; grantKey?: string }> = [];
    const gate = new ConfirmationGate(s, { confirm: async (req) => { seen.push({ alwaysAllowed: req.alwaysAllowed, grantKey: req.grantKey }); return 'allow'; } });
    await gate.check({ ...base, key: 'shell_exec:git' });
    expect(seen[0]).toEqual({ alwaysAllowed: true, grantKey: 'shell_exec:git' });
  });

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

describe('세션 허용·입력 잠금', () => {
  const input = { tool: 'mouse_click', summary: '클릭', origin: 'https://studio.aeyes.dev', accountLabel: 'a' };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('입력 도구와 db_query 는 항상 허용 키가 없고, 입력 도구만 세션 키가 있다', () => {
    for (const tool of ['mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'db_query']) {
      expect(grantKey(tool, {}), tool).toBeNull();
    }
    expect(sessionGrantKey('mouse_move')).toBe('input');
    expect(sessionGrantKey('keyboard_press')).toBe('input');
    expect(sessionGrantKey('shell_exec')).toBeNull();
    expect(sessionGrantKey('screenshot')).toBeNull();
    expect(grantKey('screenshot', {})).toBe('screenshot');
  });

  it('세션 허용은 같은 페어링에만, 설정에 남지 않고 60분 뒤 만료', async () => {
    const s = await store();
    let t = 1_000;
    const confirmer: Confirmer = { confirm: vi.fn(async () => 'session' as const) };
    const gate = new ConfirmationGate(s, confirmer, CONFIRM_TIMEOUT_MS, () => t);
    expect(await gate.check({ ...input, key: null, sessionKey: 'input', pairingId: 'p1' })).toBe(true);
    expect(await gate.check({ ...input, key: null, sessionKey: 'input', pairingId: 'p1' })).toBe(true);
    expect(confirmer.confirm).toHaveBeenCalledTimes(1);
    expect(gate.sessionGrantCount()).toBe(1);
    expect(s.get().alwaysAllow).toEqual([]);
    await gate.check({ ...input, key: null, sessionKey: 'input', pairingId: 'p2' });
    expect(confirmer.confirm).toHaveBeenCalledTimes(2);
    t += SESSION_GRANT_TTL_MS + 1;
    expect(gate.sessionGrantCount()).toBe(0);
    await gate.check({ ...input, key: null, sessionKey: 'input', pairingId: 'p1' });
    expect(confirmer.confirm).toHaveBeenCalledTimes(3);
  });

  it('세션 허용을 제안하지 않은 요청의 session 답은 이번만 허용', async () => {
    const s = await store();
    const seen: Array<boolean | undefined> = [];
    const gate = new ConfirmationGate(s, { confirm: async (req) => { seen.push(req.sessionAllowed); return 'session'; } });
    expect(await gate.check({ ...base, key: 'shell_exec:git' })).toBe(true);
    expect(await gate.check({ ...input, key: null, sessionKey: 'input' })).toBe(true);
    expect(seen).toEqual([false, false]);
    expect(gate.sessionGrantCount()).toBe(0);
  });

  it('세션 허용 가능 요청은 확인기에 sessionAllowed=true 를 넘긴다', async () => {
    const s = await store();
    const seen: Array<boolean | undefined> = [];
    const gate = new ConfirmationGate(s, { confirm: async (req) => { seen.push(req.sessionAllowed); return 'allow'; } });
    await gate.check({ ...input, key: null, sessionKey: 'input', pairingId: 'p1' });
    expect(seen).toEqual([true]);
    expect(gate.sessionGrantCount()).toBe(0);
  });

  it('clearSessionGrants 는 모두 취소하고 수를 돌려준다', async () => {
    const s = await store();
    const gate = new ConfirmationGate(s, { confirm: async () => 'session' });
    await gate.check({ ...input, key: null, sessionKey: 'input', pairingId: 'p1' });
    await gate.check({ ...input, key: null, sessionKey: 'input', pairingId: 'p2' });
    expect(gate.clearSessionGrants()).toBe(2);
    expect(gate.sessionGrantCount()).toBe(0);
  });

  it('확인 대기 중에는 입력 동작을 거부한다', async () => {
    const s = await store();
    let answer: (d: ConfirmDecision) => void = () => undefined;
    const gate = new ConfirmationGate(s, { confirm: () => new Promise<ConfirmDecision>((r) => { answer = r; }) });
    const pending = gate.check({ ...base, key: 'k' });
    await tick();
    const fn = vi.fn(async () => 'x');
    await expect(gate.withInputLock(fn)).rejects.toBeInstanceOf(InputBlockedError);
    expect(fn).not.toHaveBeenCalled();
    answer('deny');
    expect(await pending).toBe(false);
    await expect(gate.withInputLock(fn)).resolves.toBe('x');
  });

  it('입력 동작 중에는 확인 창을 입력이 끝난 뒤에 띄운다', async () => {
    const s = await store();
    const events: string[] = [];
    const gate = new ConfirmationGate(s, { confirm: async () => { events.push('confirm'); return 'allow'; } });
    let finish: () => void = () => undefined;
    const running = gate.withInputLock(() => new Promise<void>((resolve) => {
      events.push('input-start');
      finish = () => { events.push('input-end'); resolve(); };
    }));
    await tick();
    const check = gate.check({ ...base, key: 'k' });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['input-start']);
    finish();
    await running;
    expect(await check).toBe(true);
    expect(events).toEqual(['input-start', 'input-end', 'confirm']);
  });

  it('입력 동작끼리는 순서대로 실행한다', async () => {
    const s = await store();
    const gate = new ConfirmationGate(s, denyAll());
    const order: string[] = [];
    const slow = gate.withInputLock(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); });
    const fast = gate.withInputLock(async () => { order.push('b'); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a', 'b']);
  });
});

function denyAll(): Confirmer {
  return { confirm: async () => 'deny' };
}
