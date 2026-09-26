import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../src/config.js';
import { ConfirmationGate, grantKey } from '../src/policy/gate.js';
import type { Confirmer } from '../src/policy/confirmer.js';

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
