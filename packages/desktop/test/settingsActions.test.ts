import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore } from 'aeyes-local-agent';
import { describe, expect, it } from 'vitest';
import { addAllowedDir, removeAllowedDir, removeAlwaysAllow, resetAlwaysAllow } from '../src/settingsActions.js';

async function setup() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-desk-')));
  const store = await ConfigStore.open(path.join(home, '.aeyes-agent'), home);
  return { home, store };
}

describe('허용 폴더', () => {
  it('홈 아래 폴더는 실제 경로로 추가, 중복은 한 번만', async () => {
    const { home, store } = await setup();
    const dir = path.join(home, 'Shop');
    await mkdir(dir);
    expect(await addAllowedDir(store, dir, { home })).toEqual({ ok: true });
    expect(await addAllowedDir(store, dir, { home })).toEqual({ ok: true });
    expect(store.get().allowedDirs.filter((d) => d === dir)).toHaveLength(1);
  });

  it('홈 자체·설정 폴더를 포함하는 폴더·없는 폴더·파일은 거부', async () => {
    const { home, store } = await setup();
    const before = store.get().allowedDirs;
    const homeResult = await addAllowedDir(store, home, { home });
    expect(homeResult.ok).toBe(false);
    const missing = await addAllowedDir(store, path.join(home, 'nope'), { home });
    expect(missing).toEqual({ ok: false, reason: '폴더를 찾을 수 없습니다' });
    await writeFile(path.join(home, 'f.txt'), 'x');
    expect((await addAllowedDir(store, path.join(home, 'f.txt'), { home })).ok).toBe(false);
    expect(store.get().allowedDirs).toEqual(before);
  });

  it('마지막 폴더는 제거할 수 없고, 목록에 없는 폴더도 거부', async () => {
    const { home, store } = await setup();
    const [only] = store.get().allowedDirs;
    expect(await removeAllowedDir(store, only)).toEqual({ ok: false, reason: '허용 폴더가 하나는 있어야 합니다' });
    const extra = path.join(home, 'Extra');
    await mkdir(extra);
    await addAllowedDir(store, extra, { home });
    expect(await removeAllowedDir(store, extra)).toEqual({ ok: true });
    expect(await removeAllowedDir(store, extra)).toEqual({ ok: false, reason: '목록에 없는 폴더입니다' });
  });
});

describe('항상 허용', () => {
  it('하나 제거와 전체 초기화', async () => {
    const { store } = await setup();
    await store.update((c) => { c.alwaysAllow.push({ key: 'a', createdAt: 'x' }, { key: 'b', createdAt: 'x' }); });
    expect(await removeAlwaysAllow(store, 'a')).toBe(true);
    expect(await removeAlwaysAllow(store, 'a')).toBe(false);
    expect(await resetAlwaysAllow(store)).toBe(1);
    expect(store.get().alwaysAllow).toEqual([]);
  });
});
