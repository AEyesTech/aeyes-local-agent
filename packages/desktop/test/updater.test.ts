import { describe, expect, it, vi } from 'vitest';
import { startAutoUpdate, UPDATE_INTERVAL_MS } from '../src/updater.js';

function fakeUpdater(check: () => Promise<unknown> = async () => null) {
  const listeners: Array<(e: Error) => void> = [];
  return {
    autoDownload: false,
    checkForUpdatesAndNotify: vi.fn(check),
    on: vi.fn((_event: 'error', l: (e: Error) => void) => { listeners.push(l); }),
    emitError: (e: Error) => listeners.forEach((l) => l(e)),
  };
}

describe('startAutoUpdate', () => {
  it('개발 실행이면 확인하지 않는다', async () => {
    const u = fakeUpdater();
    const logs: string[] = [];
    const h = startAutoUpdate(u, { isPackaged: false, log: (m) => logs.push(m) });
    await h.checkNow();
    expect(u.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(logs[0]).toContain('개발 실행');
  });

  it('패키지된 앱이면 바로 확인하고 주기적으로 다시 확인, stop 은 예약을 취소', async () => {
    const u = fakeUpdater();
    const scheduled = { fn: (): void => undefined, ms: 0 };
    const cancel = vi.fn();
    const h = startAutoUpdate(u, {
      isPackaged: true,
      log: () => undefined,
      schedule: (fn, ms) => { scheduled.fn = fn; scheduled.ms = ms; return cancel; },
    });
    expect(u.autoDownload).toBe(true);
    expect(u.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(scheduled.ms).toBe(UPDATE_INTERVAL_MS);
    scheduled.fn();
    expect(u.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
    h.stop();
    expect(cancel).toHaveBeenCalled();
  });

  it('확인 실패와 오류 이벤트는 기록만 하고 던지지 않는다', async () => {
    const u = fakeUpdater(async () => { throw new Error('offline'); });
    const logs: string[] = [];
    const h = startAutoUpdate(u, { isPackaged: true, log: (m) => logs.push(m), schedule: () => () => undefined });
    await h.checkNow();
    u.emitError(new Error('bad signature'));
    expect(logs.some((l) => l.includes('offline'))).toBe(true);
    expect(logs.some((l) => l.includes('bad signature'))).toBe(true);
  });
});
