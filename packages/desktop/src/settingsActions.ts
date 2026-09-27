/**
 * 트레이에서 바꾸는 설정. 허용 폴더는 CLI --allow-dir 와 같은 규칙(루트·홈·홈 상위·설정 폴더 포함 금지)을 쓴다.
 * 서버는 요청마다 설정의 allowedDirs 를 읽으므로 재시작 없이 반영된다.
 */
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { unsafeAllowedDirReason, type ConfigStore } from 'aeyes-local-agent';

export type ActionResult = { ok: true } | { ok: false; reason: string };

const realOrResolved = (p: string) => realpath(p).catch(() => path.resolve(p));

export async function addAllowedDir(store: ConfigStore, dir: string, opts: { home?: string } = {}): Promise<ActionResult> {
  const real = await realpath(dir).catch(() => null);
  if (!real) return { ok: false, reason: '폴더를 찾을 수 없습니다' };
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) return { ok: false, reason: '폴더가 아닙니다' };
  const reason = unsafeAllowedDirReason(real, {
    home: await realOrResolved(opts.home ?? homedir()),
    configDir: await realOrResolved(store.dir),
  });
  if (reason) return { ok: false, reason };
  await store.update((c) => {
    if (!c.allowedDirs.includes(real)) c.allowedDirs.push(real);
  });
  return { ok: true };
}

export async function removeAllowedDir(store: ConfigStore, dir: string): Promise<ActionResult> {
  const current = store.get().allowedDirs;
  if (!current.includes(dir)) return { ok: false, reason: '목록에 없는 폴더입니다' };
  if (current.length <= 1) return { ok: false, reason: '허용 폴더가 하나는 있어야 합니다' };
  await store.update((c) => { c.allowedDirs = c.allowedDirs.filter((d) => d !== dir); });
  return { ok: true };
}

export async function removeAlwaysAllow(store: ConfigStore, key: string): Promise<boolean> {
  let removed = false;
  await store.update((c) => {
    const before = c.alwaysAllow.length;
    c.alwaysAllow = c.alwaysAllow.filter((g) => g.key !== key);
    removed = c.alwaysAllow.length < before;
  });
  return removed;
}

export async function resetAlwaysAllow(store: ConfigStore): Promise<number> {
  let count = 0;
  await store.update((c) => {
    count = c.alwaysAllow.length;
    c.alwaysAllow = [];
  });
  return count;
}
