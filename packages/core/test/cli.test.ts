import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('기본은 start', () => {
    expect(parseArgs([])).toEqual({ command: 'start', allowDirs: [], dev: false, autoConfirm: false });
  });
  it('옵션', () => {
    expect(parseArgs(['--port', '47825', '--allow-dir', '/a', '--allow-dir', '/b', '--dev', '--auto-confirm', '--config-dir', '/c']))
      .toEqual({ command: 'start', port: 47825, allowDirs: [path.resolve('/a'), path.resolve('/b')], dev: true, autoConfirm: true, configDir: path.resolve('/c') });
  });
  it('unpair --all, --help, --version', () => {
    expect(parseArgs(['unpair', '--all']).command).toBe('unpair-all');
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
  });
  it('잘못된 인자는 오류', () => {
    expect(() => parseArgs(['--port', '80'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow();
    expect(() => parseArgs(['unpair'])).toThrow();
  });
});

function streams() {
  const output = new PassThrough();
  const error = new PassThrough();
  let out = '';
  let err = '';
  output.on('data', (c: Buffer) => { out += c.toString(); });
  error.on('data', (c: Buffer) => { err += c.toString(); });
  return { input: new PassThrough(), output, error, out: () => out, err: () => err };
}

describe('main', () => {
  it('--auto-confirm 은 --dev 없이는 종료 코드 1', async () => {
    const s = streams();
    expect(await main(['--auto-confirm'], s)).toBe(1);
    expect(s.err()).toContain('--dev');
  });

  it('--version', async () => {
    const s = streams();
    expect(await main(['--version'], s)).toBe(0);
    expect(s.out().trim()).toBe('0.1.0');
  });

  it('unpair --all 은 설정의 페어링을 비운다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      allowedDirs: [path.join(dir, 'allowed')],
      pairings: [{ id: '1', tokenHash: 'h', accountLabel: 'a', browserLabel: 'b', createdAt: 'x', lastUsedAt: null }],
    }));
    const s = streams();
    expect(await main(['unpair', '--all', '--config-dir', dir], s)).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).pairings).toEqual([]);
    expect(s.out()).toContain('1');
  });

  it('start 는 코드와 포트를 보여 주고 q 로 종료', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ allowedDirs: [path.join(dir, 'allowed')] }));
    const s = streams();
    const running = main(['--config-dir', dir], s);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.out()).toMatch(/127\.0\.0\.1:478(2\d|30)/);
    expect(s.out()).toMatch(/\b\d{6}\b/);
    s.input.write('q\n');
    expect(await running).toBe(0);
  });

  it('실행 중인 에이전트가 있으면(agent.pid 살아 있음) unpair --all 은 거부되고 종료 코드 1', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      allowedDirs: [path.join(dir, 'allowed')],
      pairings: [{ id: '1', tokenHash: 'h', accountLabel: 'a', browserLabel: 'b', createdAt: 'x', lastUsedAt: null }],
    }));
    await writeFile(path.join(dir, 'agent.pid'), String(process.pid));
    const s = streams();
    expect(await main(['unpair', '--all', '--config-dir', dir], s)).toBe(1);
    expect(s.err()).toContain('실행 중');
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).pairings).toHaveLength(1);
  });

  it('agent.pid 가 죽은 프로세스를 가리키면 무시하고 unpair --all 을 진행한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      allowedDirs: [path.join(dir, 'allowed')],
      pairings: [{ id: '1', tokenHash: 'h', accountLabel: 'a', browserLabel: 'b', createdAt: 'x', lastUsedAt: null }],
    }));
    const dead = spawn(process.execPath, ['-e', '""']);
    const deadPid = await new Promise<number>((resolve) => {
      dead.on('exit', () => resolve(dead.pid!));
    });
    await writeFile(path.join(dir, 'agent.pid'), String(deadPid));
    const s = streams();
    expect(await main(['unpair', '--all', '--config-dir', dir], s)).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).pairings).toEqual([]);
  });

  it('start 는 agent.pid 를 만들고 q 로 종료하면 지운다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ allowedDirs: [path.join(dir, 'allowed')] }));
    const s = streams();
    const running = main(['--config-dir', dir], s);
    await new Promise((r) => setTimeout(r, 300));
    expect((await readFile(path.join(dir, 'agent.pid'), 'utf8')).trim()).toBe(String(process.pid));
    s.input.write('q\n');
    expect(await running).toBe(0);
    await expect(access(path.join(dir, 'agent.pid'))).rejects.toThrow();
  });

  it('같은 설정 폴더에 살아 있는 에이전트(agent.pid)가 있으면 시작을 거부한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ allowedDirs: [path.join(dir, 'allowed')] }));
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    try {
      await new Promise((r) => live.once('spawn', r));
      await writeFile(path.join(dir, 'agent.pid'), String(live.pid));
      const s = streams();
      expect(await main(['--config-dir', dir], s)).toBe(1);
      expect(s.err()).toContain(`이미 에이전트가 실행 중입니다(pid ${live.pid})`);
      expect((await readFile(path.join(dir, 'agent.pid'), 'utf8')).trim()).toBe(String(live.pid));
    } finally {
      live.kill();
    }
  });

  it('g 는 항상 허용 목록을 보여 주고 r 은 모두 지운다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      allowedDirs: [path.join(dir, 'allowed')],
      alwaysAllow: [{ key: 'shell_exec:git', createdAt: '2026-09-01T00:00:00.000Z' }, { key: 'open_path:url', createdAt: 'x' }],
    }));
    const s = streams();
    const running = main(['--config-dir', dir], s);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.out()).toContain('g = 항상 허용 목록');
    s.input.write('g\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.out()).toContain('shell_exec:git');
    expect(s.out()).toContain('open_path:url');
    s.input.write('r\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(s.out()).toContain('항상 허용 2개를 지웠습니다');
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).alwaysAllow).toEqual([]);
    s.input.write('g\n');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.out()).toContain('항상 허용 없음');
    s.input.write('q\n');
    expect(await running).toBe(0);
  });

  it('--help 에 g / r 명령이 있다', async () => {
    const s = streams();
    expect(await main(['--help'], s)).toBe(0);
    expect(s.out()).toContain('g = 항상 허용 목록');
    expect(s.out()).toContain('r = 항상 허용 초기화');
  });

  it('너무 넓은 --allow-dir(루트·홈·홈 상위·설정 폴더 포함)은 종료 코드 1', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    const cfg = path.join(dir, 'cfg');
    for (const broad of [path.parse(process.cwd()).root, homedir(), path.dirname(homedir()), dir]) {
      const s = streams();
      expect(await main(['--config-dir', cfg, '--allow-dir', broad], s), broad).toBe(1);
      expect(s.err()).toContain('--allow-dir');
    }
    const saved = JSON.parse(await readFile(path.join(cfg, 'config.json'), 'utf8'));
    expect(saved.allowedDirs.some((d: string) => d === dir || d === homedir())).toBe(false);
  });

  it('포트를 모두 쓸 수 없으면 메시지와 종료 코드 1', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ allowedDirs: [path.join(dir, 'allowed')] }));
    const s = streams();
    const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    expect(await main(['--config-dir', dir], s, { startAgent: async () => { throw busy; } })).toBe(1);
    expect(s.err()).toContain('47821~47830');
    await expect(access(path.join(dir, 'agent.pid'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('u 처리 중 저장 실패는 오류를 출력하고 계속 실행된다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-cli-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ allowedDirs: [path.join(dir, 'allowed')] }));
    const s = streams();
    const running = main(['--config-dir', dir], s);
    await new Promise((r) => setTimeout(r, 300));
    await chmod(path.join(dir, 'config.json'), 0o400);
    s.input.write('u\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(s.err()).toContain('연결 해제에 실패했습니다');
    await chmod(path.join(dir, 'config.json'), 0o600);
    s.input.write('q\n');
    expect(await running).toBe(0);
  });
});
