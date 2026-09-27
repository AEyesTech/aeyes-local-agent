/**
 * 설정 폴더의 agent.pid — 같은 설정 폴더로 에이전트(터미널 CLI·데스크톱 앱)가 둘 뜨지 않게 한다.
 * CLI 와 데스크톱 앱이 같은 파일을 쓰므로 서로의 실행도 막는다.
 */
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PID_FILE = 'agent.pid';
/** 방금 만들어져 아직 pid 가 적히지 않은(비었거나 깨진) 파일을 오래된 파일로 보지 않는 시간. */
const FRESH_PID_FILE_MS = 5_000;

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

/** agent.pid 를 다른 살아 있는 에이전트가 쥐고 있다. */
export class AgentAlreadyRunningError extends Error {
  readonly code = 'EEXIST';
  constructor(readonly pid: number | null) {
    super(pid !== null
      ? `이미 에이전트가 실행 중입니다(pid ${pid}). 실행 중인 에이전트를 사용하거나 먼저 종료하세요.`
      : '이미 에이전트가 실행 중입니다. 실행 중인 에이전트를 사용하거나 먼저 종료하세요.');
    this.name = 'AgentAlreadyRunningError';
  }
}

async function readPid(file: string): Promise<number | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * agent.pid 를 배타적으로 만든다(flag 'wx'). 이미 있으면: 자기 pid 면 그대로 두고, 살아 있는 pid 면
 * AgentAlreadyRunningError, 죽었거나 깨진 파일이면 지우고 한 번 더 배타적으로 만든다(그래도 EEXIST 면 실행 중으로 본다).
 */
export async function writePidFile(
  configDir: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = isPidAlive
): Promise<void> {
  const file = path.join(configDir, PID_FILE);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(file, String(pid), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readPid(file);
      if (existing === pid) return;
      if ((existing !== null && alive(existing)) || attempt > 0) throw new AgentAlreadyRunningError(existing);
      if (existing === null) {
        // 다른 인스턴스가 방금 'wx' 로 만들고 아직 pid 를 쓰지 않았을 수 있다 — 최근 파일이면 실행 중으로 본다.
        const mtime = await stat(file).then((st) => st.mtimeMs).catch(() => 0);
        if (Date.now() - mtime < FRESH_PID_FILE_MS) throw new AgentAlreadyRunningError(null);
      }
      // 오래된(죽은 pid·깨진) 파일 — 지우고 다시 배타적으로 만든다.
      await unlink(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    }
  }
}

/** 자기 pid 가 적힌 경우에만 지운다 — 다른 인스턴스가 쓴 파일을 지우지 않게. */
export async function removePidFile(configDir: string, pid: number = process.pid): Promise<void> {
  const file = path.join(configDir, PID_FILE);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text !== null && Number(text.trim()) === pid) await unlink(file).catch(() => undefined);
}
