import { describe, expect, it, vi } from 'vitest';
import { acquireInstance } from '../src/instance.js';

describe('acquireInstance', () => {
  it('두 번째 데스크톱 실행이면 second_desktop', async () => {
    const readRunningPid = vi.fn(async () => null);
    expect(await acquireInstance('/c', { requestSingleInstanceLock: () => false, readRunningPid, pid: 1 }))
      .toEqual({ ok: false, reason: 'second_desktop' });
    expect(readRunningPid).not.toHaveBeenCalled();
  });

  it('다른 에이전트(CLI)가 같은 설정 폴더로 실행 중이면 agent_running', async () => {
    expect(await acquireInstance('/c', { requestSingleInstanceLock: () => true, readRunningPid: async () => 4242, pid: 1 }))
      .toEqual({ ok: false, reason: 'agent_running', pid: 4242 });
  });

  it('pid 파일이 없거나 자기 pid 면 ok', async () => {
    expect(await acquireInstance('/c', { requestSingleInstanceLock: () => true, readRunningPid: async () => null, pid: 1 })).toEqual({ ok: true });
    expect(await acquireInstance('/c', { requestSingleInstanceLock: () => true, readRunningPid: async () => 7, pid: 7 })).toEqual({ ok: true });
  });
});
