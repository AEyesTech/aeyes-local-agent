import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../src/cli.js';
import { connectionStringError } from '../src/db/connection.js';
import { readSecretLine } from '../src/secretInput.js';

const SECRET = 'SECRETPW-123';
const PG = `postgres://reader:${SECRET}@localhost:5432/shop`;

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let out = '';
  let err = '';
  output.on('data', (c: Buffer) => { out += c.toString(); });
  error.on('data', (c: Buffer) => { err += c.toString(); });
  return { input, output, error, out: () => out, err: () => err };
}

async function configDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-clidb-'));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ allowedDirs: [path.join(dir, 'allowed')] }));
  return dir;
}

const saved = async (dir: string) => JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));

describe('parseArgs db', () => {
  it('add/list/remove 와 옵션', () => {
    expect(parseArgs(['db', 'add', 'shop', '--kind', 'postgres'])).toMatchObject({ command: 'db-add', dbName: 'shop', dbKind: 'postgres' });
    expect(parseArgs(['db', 'add', 'erp', '--kind', 'mysql', '--read-write'])).toMatchObject({ command: 'db-add', dbKind: 'mysql', dbReadWrite: true });
    expect(parseArgs(['db', 'list']).command).toBe('db-list');
    expect(parseArgs(['db', 'remove', 'shop'])).toMatchObject({ command: 'db-remove', dbName: 'shop' });
  });
  it('잘못된 형태는 오류', () => {
    expect(() => parseArgs(['db'])).toThrow();
    expect(() => parseArgs(['db', 'add', 'shop'])).toThrow('--kind');
    expect(() => parseArgs(['db', 'add', '--kind', 'postgres'])).toThrow();
    expect(() => parseArgs(['db', 'add', 'shop', '--kind', 'oracle'])).toThrow();
    expect(() => parseArgs(['db', 'drop', 'x'])).toThrow();
  });
});

describe('db 명령', () => {
  it('db add 는 연결 문자열을 입력에서 받아 저장하고 출력하지 않는다(기본 읽기 전용)', async () => {
    const dir = await configDir();
    const s = streams();
    s.input.write(`${PG}\n`);
    expect(await main(['db', 'add', 'shop', '--kind', 'postgres', '--config-dir', dir], s)).toBe(0);
    expect((await saved(dir)).databases).toEqual([{ name: 'shop', kind: 'postgres', connectionString: PG, readOnly: true }]);
    expect(s.out()).toContain("DB 'shop'");
    expect(s.out() + s.err()).not.toContain(SECRET);
    expect(s.out() + s.err()).not.toContain('localhost:5432');
    if (process.platform !== 'win32') expect((await stat(path.join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
  });

  it('--read-write 는 readOnly false', async () => {
    const dir = await configDir();
    const s = streams();
    s.input.write('mysql://w:pw@127.0.0.1:3306/erp\n');
    expect(await main(['db', 'add', 'erp', '--kind', 'mysql', '--read-write', '--config-dir', dir], s)).toBe(0);
    expect((await saved(dir)).databases[0]).toMatchObject({ name: 'erp', readOnly: false });
  });

  it('형식이 틀리면 종료 코드 1, 저장하지 않고 값을 되풀이하지 않는다', async () => {
    const dir = await configDir();
    const s = streams();
    s.input.write(`mysql://u:${SECRET}@h/db\n`);
    expect(await main(['db', 'add', 'shop', '--kind', 'postgres', '--config-dir', dir], s)).toBe(1);
    expect((await saved(dir)).databases).toEqual([]);
    expect(s.err()).toContain('postgres://');
    expect(s.err()).not.toContain(SECRET);
  });

  it('이름 중복·잘못된 이름은 1', async () => {
    const dir = await configDir();
    const a = streams();
    a.input.write(`${PG}\n`);
    await main(['db', 'add', 'shop', '--kind', 'postgres', '--config-dir', dir], a);
    const b = streams();
    b.input.write(`${PG}\n`);
    expect(await main(['db', 'add', 'shop', '--kind', 'postgres', '--config-dir', dir], b)).toBe(1);
    expect(b.err()).toContain('이미 있는');
    const c = streams();
    expect(await main(['db', 'add', '-bad', '--kind', 'postgres', '--config-dir', dir], c)).toBe(1);
  });

  it('db list 는 이름·종류·권한만 보여 준다', async () => {
    const dir = await configDir();
    const a = streams();
    a.input.write(`${PG}\n`);
    await main(['db', 'add', 'shop', '--kind', 'postgres', '--config-dir', dir], a);
    const s = streams();
    expect(await main(['db', 'list', '--config-dir', dir], s)).toBe(0);
    expect(s.out()).toContain('shop (postgres, 읽기 전용)');
    expect(s.out()).not.toContain(SECRET);
    const empty = streams();
    await main(['db', 'list', '--config-dir', await configDir()], empty);
    expect(empty.out()).toContain('DB 연결 없음');
  });

  it('db remove 는 지우고, 없는 이름은 1', async () => {
    const dir = await configDir();
    const a = streams();
    a.input.write(`${PG}\n`);
    await main(['db', 'add', 'shop', '--kind', 'postgres', '--config-dir', dir], a);
    expect(await main(['db', 'remove', 'shop', '--config-dir', dir], streams())).toBe(0);
    expect((await saved(dir)).databases).toEqual([]);
    expect(await main(['db', 'remove', 'shop', '--config-dir', dir], streams())).toBe(1);
  });

  it('에이전트가 실행 중이면 db add/remove 는 거부', async () => {
    const dir = await configDir();
    await writeFile(path.join(dir, 'agent.pid'), String(process.ppid));
    const s = streams();
    s.input.write(`${PG}\n`);
    expect(await main(['db', 'add', 'shop', '--kind', 'postgres', '--config-dir', dir], s)).toBe(1);
    expect(s.err()).toContain('실행 중');
    expect((await saved(dir)).databases).toEqual([]);
  });
});

describe('connectionStringError', () => {
  it('스킴·호스트 검사', () => {
    expect(connectionStringError('postgres', PG)).toBeNull();
    expect(connectionStringError('postgres', 'postgresql:///shop?host=/var/run/postgresql')).toBeNull();
    expect(connectionStringError('mysql', 'mysql://u:p@h:3306/db')).toBeNull();
    expect(connectionStringError('postgres', 'mysql://h/db')).toContain('postgres://');
    expect(connectionStringError('mysql', 'not a url')).toContain('URL');
    expect(connectionStringError('postgres', 'postgres:///db')).toContain('호스트');
    expect(connectionStringError('postgres', '')).toContain('비어');
  });
});

describe('readSecretLine', () => {
  it('터미널이면 raw 모드로 받아 에코하지 않고 백스페이스를 처리한다', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const output = new PassThrough();
    let printed = '';
    output.on('data', (c: Buffer) => { printed += c.toString(); });
    const p = readSecretLine(input, output, '비밀: ');
    input.write('ab\u007fc\r');
    expect(await p).toBe('ac');
    expect(printed).toBe('비밀: \n');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it('Ctrl-C 는 취소', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const p = readSecretLine(input, new PassThrough(), '비밀: ');
    input.write('ab\u0003');
    await expect(p).rejects.toThrow('취소');
  });
});
