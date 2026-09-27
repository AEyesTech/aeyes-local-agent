import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentAlreadyRunningError, isPidAlive, PID_FILE, readRunningPid, removePidFile, writePidFile } from '../src/pidFile.js';

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

  it('writePidFile 은 배타적으로 만든다: 살아 있는 다른 pid 가 있으면 AgentAlreadyRunningError(EEXIST)', async () => {
    const d = await dir();
    await writeFile(path.join(d, PID_FILE), '4242');
    const error = await writePidFile(d, 7, () => true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentAlreadyRunningError);
    expect((error as AgentAlreadyRunningError).pid).toBe(4242);
    expect((error as AgentAlreadyRunningError).code).toBe('EEXIST');
    // 실행 중인 에이전트가 없으면 지워도 되는 pid 파일 경로를 알려 준다((e)).
    expect((error as Error).message).toContain(`${path.join(d, PID_FILE)} 파일을 지운 뒤`);
    expect(await readFile(path.join(d, PID_FILE), 'utf8')).toBe('4242');
  });

  it('writePidFile: 죽은 pid·깨진 파일은 지우고 새로 만든다', async () => {
    const d = await dir();
    await writeFile(path.join(d, PID_FILE), '4242');
    await writePidFile(d, 7, () => false);
    expect(await readFile(path.join(d, PID_FILE), 'utf8')).toBe('7');
    await writeFile(path.join(d, PID_FILE), 'garbage');
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(d, PID_FILE), old, old);
    await writePidFile(d, 8, () => true);
    expect(await readFile(path.join(d, PID_FILE), 'utf8')).toBe('8');
  });

  it('writePidFile: 방금 만들어진 빈 파일(다른 인스턴스가 쓰는 중)은 실행 중으로 본다', async () => {
    const d = await dir();
    await writeFile(path.join(d, PID_FILE), '');
    await expect(writePidFile(d, 9, () => true)).rejects.toBeInstanceOf(AgentAlreadyRunningError);
    expect(await readFile(path.join(d, PID_FILE), 'utf8')).toBe('');
  });

  it('writePidFile: 자기 pid 가 이미 적혀 있으면 그대로 둔다', async () => {
    const d = await dir();
    await writePidFile(d, 7);
    await expect(writePidFile(d, 7, () => true)).resolves.toBeUndefined();
  });

  it('writePidFile: 동시에 둘이 만들면 하나만 성공한다', async () => {
    const d = await dir();
    const results = await Promise.allSettled([writePidFile(d, 11, () => true), writePidFile(d, 12, () => true)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AgentAlreadyRunningError);
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
