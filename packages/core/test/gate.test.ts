import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../src/config.js';
import {
  CONFIRM_TIMEOUT_MS, ConfirmationGate, grantKey, INPUT_ABANDON_MAX_MS, INPUT_LOCK_TIMEOUT_MS, INPUT_SETTLE_MS, InputBlockedError,
  referencesConfigDir, SESSION_GRANT_TTL_MS, sessionGrantKey,
} from '../src/policy/gate.js';
import { ToolError } from '../src/errors.js';
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

describe('입력 잠금 시간 제한', () => {
  it('기본 입력 잠금 제한은 30초', () => {
    expect(INPUT_LOCK_TIMEOUT_MS).toBe(30_000);
  });

  it('끝나지 않는 입력 동작은 제한 시간 뒤 timeout 으로 실패하고, 버려진 호출이 남아 있는 동안 새 확인은 묻지 않고 거부한다', async () => {
    const s = await store();
    const asked: string[] = [];
    const gate = new ConfirmationGate(s, { confirm: async (req) => { asked.push(req.tool); return 'allow'; } }, CONFIRM_TIMEOUT_MS, Date.now, 30, 0);
    const hung = gate.withInputLock(() => new Promise<never>(() => undefined));
    await new Promise((r) => setTimeout(r, 0));
    const check = gate.decide({ tool: 'shell_exec', summary: 'ls', origin: 'o', accountLabel: 'a', key: 'k' });
    const error = await hung.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('timeout');
    expect(await check).toEqual({ allowed: false, reason: 'input_unsettled' });
    expect(await gate.check({ tool: 'fs_delete', summary: 'x', origin: 'o', accountLabel: 'a', key: 'fs_delete' })).toBe(false);
    expect(asked).toEqual([]);
    expect(gate.hasAbandonedInput()).toBe(true);
    // 입력 잠금 자체는 풀려 있다.
    await expect(gate.withInputLock(async () => 'next')).resolves.toBe('next');
  });

  it('입력 동작이 예외를 던져도 잠금이 풀린다', async () => {
    const s = await store();
    const gate = new ConfirmationGate(s, denyAll(), CONFIRM_TIMEOUT_MS, Date.now, 1_000);
    await expect(gate.withInputLock(async () => { throw new Error('driver failed'); })).rejects.toThrow('driver failed');
    await expect(gate.withInputLock(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('입력 뒤 확인 유예(C1)·버려진 입력 호출(I1) — 가짜 타이머', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('상수: 유예 1초, 버려진 입력 상한 60초', () => {
    expect(INPUT_SETTLE_MS).toBe(1_000);
    expect(INPUT_ABANDON_MAX_MS).toBe(60_000);
  });

  it('입력 동작이 끝난 뒤에도 INPUT_SETTLE_MS 동안은 확인을 띄우지 않는다', async () => {
    const s = await store();
    vi.useFakeTimers();
    const confirm = vi.fn(async () => 'allow' as const);
    const gate = new ConfirmationGate(s, { confirm });
    let finish: () => void = () => undefined;
    const running = gate.withInputLock(() => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    const check = gate.check({ ...base, key: 'k' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(confirm).not.toHaveBeenCalled();
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(INPUT_SETTLE_MS - 1);
    expect(confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await check).toBe(true);
  });

  it('유예 중에 이미 줄 서 있던 입력 동작이 있으면 그 동작의 유예까지 기다린다', async () => {
    const s = await store();
    vi.useFakeTimers();
    const confirm = vi.fn(async () => 'allow' as const);
    const gate = new ConfirmationGate(s, { confirm });
    let finishA: () => void = () => undefined;
    const a = gate.withInputLock(() => new Promise<void>((resolve) => { finishA = resolve; }));
    const b = gate.withInputLock(async () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const check = gate.check({ ...base, key: 'k' });
    finishA();
    await a;
    // b 는 확인 대기 중이라 busy 로 거부되지만, 그 뒤에도 유예를 지킨다.
    await expect(b).rejects.toBeInstanceOf(InputBlockedError);
    await vi.advanceTimersByTimeAsync(INPUT_SETTLE_MS - 1);
    expect(confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await check).toBe(true);
  });

  it('입력 동작이 없으면 확인을 바로 띄운다', async () => {
    const s = await store();
    vi.useFakeTimers();
    const confirm = vi.fn(async () => 'allow' as const);
    const gate = new ConfirmationGate(s, { confirm });
    const check = gate.check({ ...base, key: 'k' });
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await check).toBe(true);
  });

  it('버려진 입력 호출이 끝나면 다시 확인을 묻는다', async () => {
    const s = await store();
    vi.useFakeTimers();
    const confirm = vi.fn(async () => 'allow' as const);
    const gate = new ConfirmationGate(s, { confirm }, CONFIRM_TIMEOUT_MS, Date.now, 1_000);
    let finishDriver: () => void = () => undefined;
    const call = gate.withInputLock(() => new Promise<void>((resolve) => { finishDriver = resolve; }));
    const outcome = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBeInstanceOf(ToolError);
    await vi.advanceTimersByTimeAsync(INPUT_SETTLE_MS);
    expect(await gate.decide({ ...base, key: 'k' })).toEqual({ allowed: false, reason: 'input_unsettled' });
    expect(confirm).not.toHaveBeenCalled();
    finishDriver();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.hasAbandonedInput()).toBe(false);
    expect(await gate.check({ ...base, key: 'k' })).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('끝나지 않는 버려진 호출은 시간 초과 뒤 INPUT_ABANDON_MAX_MS 가 지나면 더 이상 막지 않는다', async () => {
    const s = await store();
    vi.useFakeTimers();
    const confirm = vi.fn(async () => 'allow' as const);
    const gate = new ConfirmationGate(s, { confirm }, CONFIRM_TIMEOUT_MS, Date.now, 1_000);
    const outcome = gate.withInputLock(() => new Promise<never>(() => undefined)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBeInstanceOf(ToolError);
    await vi.advanceTimersByTimeAsync(INPUT_ABANDON_MAX_MS - 1);
    expect(await gate.check({ ...base, key: 'k' })).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await gate.check({ ...base, key: 'k' })).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('확인을 기다리는 동안 입력이 시간 초과로 버려지면 확인을 띄우지 않고 거부한다', async () => {
    const s = await store();
    vi.useFakeTimers();
    const confirm = vi.fn(async () => 'allow' as const);
    const gate = new ConfirmationGate(s, { confirm }, CONFIRM_TIMEOUT_MS, Date.now, 1_000);
    const outcome = gate.withInputLock(() => new Promise<never>(() => undefined)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const check = gate.decide({ ...base, key: 'k' });
    await vi.advanceTimersByTimeAsync(1_000 + INPUT_SETTLE_MS);
    expect(await outcome).toBeInstanceOf(ToolError);
    expect(await check).toEqual({ allowed: false, reason: 'input_unsettled' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('도구가 스스로 던진 timeout 오류는 버려진 호출로 보지 않는다', async () => {
    const s = await store();
    const gate = new ConfirmationGate(s, { confirm: async () => 'allow' }, CONFIRM_TIMEOUT_MS, Date.now, 1_000, 0);
    await expect(gate.withInputLock(async () => { throw new ToolError('timeout', 'x'); })).rejects.toBeInstanceOf(ToolError);
    expect(gate.hasAbandonedInput()).toBe(false);
  });
});

describe('설정 폴더를 가리키는 shell_exec 는 항상 허용 불가(I2)', () => {
  const home = '/Users/me';
  const cfg = '/Users/me/.aeyes-agent';

  it('설정 폴더 경로·~ 상대 경로·폴더 이름·aeyes-agent·config.json 을 가리키면 null', () => {
    for (const command of [
      'cat /Users/me/.aeyes-agent/config.json', 'cat ~/.aeyes-agent/config.json', 'less ~/.AEYES-AGENT/x',
      'grep -r pass /Users/me/.aeyes-agent', 'ls .aeyes-agent', 'cat AEYES-AGENT', 'cat config.json', 'type Config.JSON',
    ]) {
      expect(grantKey('shell_exec', { command }, cfg), command).toBeNull();
    }
    // configDir 없이도 이름 규칙은 적용된다.
    expect(grantKey('shell_exec', { command: 'cat ~/.aeyes-agent/config.json' })).toBeNull();
    expect(grantKey('shell_exec', { command: 'git status' }, cfg)).toBe('shell_exec:git');
  });

  it('사용자 지정 설정 폴더는 실제 경로·~ 상대 경로·폴더 이름으로 판단', () => {
    const custom = '/Users/me/work/agentcfg';
    expect(referencesConfigDir('cat /Users/me/work/agentcfg/x', custom, home)).toBe(true);
    expect(referencesConfigDir('cat ~/work/agentcfg/x', custom, home)).toBe(true);
    expect(referencesConfigDir('cd agentcfg', custom, home)).toBe(true);
    expect(referencesConfigDir('ls ~/work', custom, home)).toBe(false);
  });

  it('Windows 설정 폴더(%APPDATA%\\aeyes-agent)도 이름으로 걸린다', () => {
    expect(grantKey('shell_exec', { command: 'type %APPDATA%\\aeyes-agent\\config.json' }, 'C:\\Users\\me\\AppData\\Roaming\\aeyes-agent')).toBeNull();
  });

  it('항상 허용된 명령이라도 설정 폴더를 가리키면 기록을 보지 않고 묻는다', async () => {
    const s = await store();
    await s.update((c) => { c.alwaysAllow.push({ key: 'shell_exec:cat', createdAt: 'x' }); });
    const confirm = vi.fn(async () => 'deny' as const);
    const gate = new ConfirmationGate(s, { confirm });
    const key = grantKey('shell_exec', { command: `cat ${s.dir}/config.json` }, s.dir);
    expect(key).toBeNull();
    expect(await gate.check({ ...base, summary: 'cat', key })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

function denyAll(): Confirmer {
  return { confirm: async () => 'deny' };
}
