import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
});
