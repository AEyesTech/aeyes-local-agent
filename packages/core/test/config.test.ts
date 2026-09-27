import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigCorruptedError, ConfigStore, defaultAllowedDir, defaultConfigDir, DEFAULT_PORT } from '../src/config.js';

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), 'aeyes-home-'));
}

describe('defaultConfigDir', () => {
  it('macOS/Linux 는 ~/.aeyes-agent', () => {
    expect(defaultConfigDir('darwin', {}, '/Users/a')).toBe('/Users/a/.aeyes-agent');
  });
  it('Windows 는 %APPDATA%\\aeyes-agent', () => {
    expect(defaultConfigDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'))
      .toBe('C:\\Users\\a\\AppData\\Roaming\\aeyes-agent');
  });
});

describe('defaultAllowedDir', () => {
  it('macOS/Linux 는 ~/Documents/AeyeStudio', () => {
    expect(defaultAllowedDir('/Users/a', 'darwin', {}, () => false)).toBe('/Users/a/Documents/AeyeStudio');
    expect(defaultAllowedDir('/home/a', 'linux', { OneDrive: '/x' }, () => true)).toBe('/home/a/Documents/AeyeStudio');
  });

  it('Windows 는 OneDrive 로 옮겨진 문서 폴더를 먼저 찾는다', () => {
    const home = 'C:\\Users\\a';
    const env = { OneDrive: 'C:\\Users\\a\\OneDrive - Company', USERPROFILE: home };
    const only = (...existing: string[]) => (p: string) => existing.includes(p);
    expect(defaultAllowedDir(home, 'win32', env, only('C:\\Users\\a\\OneDrive - Company\\Documents', 'C:\\Users\\a\\Documents')))
      .toBe('C:\\Users\\a\\OneDrive - Company\\Documents\\AeyeStudio');
    expect(defaultAllowedDir(home, 'win32', env, only('C:\\Users\\a\\OneDrive\\Documents', 'C:\\Users\\a\\Documents')))
      .toBe('C:\\Users\\a\\OneDrive\\Documents\\AeyeStudio');
    expect(defaultAllowedDir(home, 'win32', { USERPROFILE: home }, only('C:\\Users\\a\\Documents')))
      .toBe('C:\\Users\\a\\Documents\\AeyeStudio');
    expect(defaultAllowedDir(home, 'win32', {}, only()))
      .toBe('C:\\Users\\a\\Documents\\AeyeStudio');
  });
});

describe('ConfigStore', () => {
  it('처음 열면 기본값을 저장하고 기본 허용 폴더를 만든다', async () => {
    const home = await tempHome();
    const dir = path.join(home, '.aeyes-agent');
    const store = await ConfigStore.open(dir, home);
    const cfg = store.get();
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.allowedDirs).toEqual([path.join(home, 'Documents', 'AeyeStudio')]);
    expect((await stat(cfg.allowedDirs[0])).isDirectory()).toBe(true);
    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.pairings).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('설정 파일 권한은 0600', async () => {
    const home = await tempHome();
    const dir = path.join(home, '.aeyes-agent');
    await ConfigStore.open(dir, home);
    expect((await stat(path.join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('설정 폴더 권한은 0700(연결 문자열 등 비밀 보관)', async () => {
    const home = await tempHome();
    const dir = path.join(home, '.aeyes-agent');
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await ConfigStore.open(dir, home);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('update 는 저장하고 get 은 복사본을 준다', async () => {
    const home = await tempHome();
    const store = await ConfigStore.open(path.join(home, '.a'), home);
    await store.update((c) => { c.alwaysAllow.push({ key: 'shell_exec:git', createdAt: 'x' }); });
    const copy = store.get();
    copy.alwaysAllow.length = 0;
    expect(store.get().alwaysAllow).toHaveLength(1);
    const reopened = await ConfigStore.open(path.join(home, '.a'), home);
    expect(reopened.get().alwaysAllow[0].key).toBe('shell_exec:git');
  });

  it('동시 update 가 서로 덮어쓰지 않는다', async () => {
    const home = await tempHome();
    const store = await ConfigStore.open(path.join(home, '.a'), home);
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      store.update((c) => { c.alwaysAllow.push({ key: `k${i}`, createdAt: 'x' }); })));
    expect(store.get().alwaysAllow).toHaveLength(10);
  });

  it('refuses corrupted config: 깨진 JSON 이면 덮어쓰지 않고 오류', async () => {
    const home = await tempHome();
    const dir = path.join(home, '.a');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), '{ broken');
    await expect(ConfigStore.open(dir, home)).rejects.toBeInstanceOf(ConfigCorruptedError);
    expect(await readFile(path.join(dir, 'config.json'), 'utf8')).toBe('{ broken');
  });

  it('알 수 없는 필드와 잘못된 타입은 기본값으로 정리한다', async () => {
    const home = await tempHome();
    const dir = path.join(home, '.a');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ port: 'x', allowedDirs: [], pairings: 'no', extra: 1 }));
    const cfg = (await ConfigStore.open(dir, home)).get();
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.allowedDirs).toEqual([path.join(home, 'Documents', 'AeyeStudio')]);
    expect(cfg.pairings).toEqual([]);
    expect('extra' in cfg).toBe(false);
  });

  it('databases: 잘못된 항목은 버리고 readOnly 기본은 true, 이름 중복은 처음 것만', async () => {
    const home = await tempHome();
    const dir = path.join(home, '.a');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      databases: [
        { name: 'shop', kind: 'postgres', connectionString: 'postgres://u:p@h/db' },
        { name: 'erp', kind: 'mysql', connectionString: 'mysql://u:p@h/db', readOnly: false },
        { name: 'shop', kind: 'mysql', connectionString: 'mysql://x' },
        { name: 'bad name!', kind: 'postgres', connectionString: 'postgres://h/db' },
        { name: 'ora', kind: 'oracle', connectionString: 'x' },
        { name: 'empty', kind: 'postgres' },
        'nope',
      ],
    }));
    const cfg = (await ConfigStore.open(dir, home)).get();
    expect(cfg.databases).toEqual([
      { name: 'shop', kind: 'postgres', connectionString: 'postgres://u:p@h/db', readOnly: true },
      { name: 'erp', kind: 'mysql', connectionString: 'mysql://u:p@h/db', readOnly: false },
    ]);
  });

  it('databases 가 없으면 빈 배열', async () => {
    const home = await tempHome();
    expect((await ConfigStore.open(path.join(home, '.a'), home)).get().databases).toEqual([]);
  });
});
