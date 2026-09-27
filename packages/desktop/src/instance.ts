/**
 * 단일 실행: 데스크톱 앱 두 개(Electron 단일 인스턴스 잠금), 데스크톱 + 터미널 에이전트(설정 폴더의 agent.pid)를 막는다.
 */
export interface InstanceDeps {
  requestSingleInstanceLock(): boolean;
  readRunningPid(dir: string): Promise<number | null>;
  pid: number;
}

export type InstanceResult =
  | { ok: true }
  | { ok: false; reason: 'second_desktop' }
  | { ok: false; reason: 'agent_running'; pid: number };

export async function acquireInstance(configDir: string, deps: InstanceDeps): Promise<InstanceResult> {
  if (!deps.requestSingleInstanceLock()) return { ok: false, reason: 'second_desktop' };
  const pid = await deps.readRunningPid(configDir);
  if (pid !== null && pid !== deps.pid) return { ok: false, reason: 'agent_running', pid };
  return { ok: true };
}
