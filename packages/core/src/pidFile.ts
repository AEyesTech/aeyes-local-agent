/**
 * 설정 폴더의 agent.pid — 같은 설정 폴더로 에이전트(터미널 CLI·데스크톱 앱)가 둘 뜨지 않게 한다.
 * CLI 와 데스크톱 앱이 같은 파일을 쓰므로 서로의 실행도 막는다.
 */
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PID_FILE = 'agent.pid';

/** pid 가 살아 있는 프로세스인지. 권한 오류(EPERM)는 살아 있는 것으로 본다(다른 사용자 소유 등). */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = (p, s) => { process.kill(p, s); }
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** agent.pid 가 살아 있는 pid 를 가리키면 그 pid, 없거나 깨졌거나 죽은 pid 면 null. */
export async function readRunningPid(configDir: string, alive: (pid: number) => boolean = isPidAlive): Promise<number | null> {
  try {
    const pid = Number((await readFile(path.join(configDir, PID_FILE), 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function writePidFile(configDir: string, pid: number = process.pid): Promise<void> {
  await writeFile(path.join(configDir, PID_FILE), String(pid), { encoding: 'utf8', mode: 0o600 });
}

/** 자기 pid 가 적힌 경우에만 지운다 — 다른 인스턴스가 쓴 파일을 지우지 않게. */
export async function removePidFile(configDir: string, pid: number = process.pid): Promise<void> {
  const file = path.join(configDir, PID_FILE);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text !== null && Number(text.trim()) === pid) await unlink(file).catch(() => undefined);
}
