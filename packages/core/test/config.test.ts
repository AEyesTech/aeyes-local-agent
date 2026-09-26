import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigCorruptedError, ConfigStore, defaultConfigDir, DEFAULT_PORT } from '../src/config.js';

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
});
