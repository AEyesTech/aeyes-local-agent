import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPidAlive, PID_FILE, readRunningPid, removePidFile, writePidFile } from '../src/pidFile.js';

const dir = () => mkdtemp(path.join(tmpdir(), 'aeyes-pid-'));

describe('pidFile', () => {
  it('쓰고 읽으면 살아 있는 자기 pid', async () => {
    const d = await dir();
    await writePidFile(d);
    expect(await readRunningPid(d)).toBe(process.pid);
  });

  it('죽은 pid·깨진 내용·파일 없음은 null', async () => {
    const d = await dir();
    expect(await readRunningPid(d)).toBeNull();
    await writeFile(path.join(d, PID_FILE), 'abc');
    expect(await readRunningPid(d)).toBeNull();
    await writeFile(path.join(d, PID_FILE), '12345');
    expect(await readRunningPid(d, () => false)).toBeNull();
    expect(await readRunningPid(d, () => true)).toBe(12345);
  });

  it('removePidFile 은 자기 pid 가 적힌 경우에만 지운다', async () => {
    const d = await dir();
    await writeFile(path.join(d, PID_FILE), '999999');
    await removePidFile(d, 1);
    expect(await readFile(path.join(d, PID_FILE), 'utf8')).toBe('999999');
    await removePidFile(d, 999999);
    await expect(stat(path.join(d, PID_FILE))).rejects.toThrow();
  });

  it('isPidAlive: EPERM 은 살아 있음, ESRCH 는 죽음', () => {
    const throwing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(isPidAlive(1, throwing('EPERM'))).toBe(true);
    expect(isPidAlive(1, throwing('ESRCH'))).toBe(false);
    expect(isPidAlive(1, () => undefined)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('pid 파일 권한은 0600', async () => {
    const d = await dir();
    await writePidFile(d);
    expect((await stat(path.join(d, PID_FILE))).mode & 0o777).toBe(0o600);
  });
});
