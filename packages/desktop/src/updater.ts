/**
 * 자동 업데이트(electron-updater + GitHub Releases). 개발 실행에서는 확인하지 않는다.
 * macOS 는 서명된 빌드만 자동 업데이트가 적용된다(미서명·ad-hoc 빌드는 오류를 기록만 한다).
 */
export interface UpdaterLike {
  autoDownload: boolean;
  checkForUpdatesAndNotify(): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface AutoUpdateHandle {
  checkNow(): Promise<void>;
  stop(): void;
}

export const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export function startAutoUpdate(
  updater: UpdaterLike,
  opts: { isPackaged: boolean; log(message: string): void; intervalMs?: number; schedule?: (fn: () => void, ms: number) => () => void }
): AutoUpdateHandle {
  if (!opts.isPackaged) {
    return {
      checkNow: async () => { opts.log('개발 실행에서는 업데이트를 확인하지 않습니다'); },
      stop: () => undefined,
    };
  }
  updater.autoDownload = true;
  updater.on('error', (error) => opts.log(`업데이트 오류: ${error.message}`));
  const checkNow = async () => {
    try {
      await updater.checkForUpdatesAndNotify();
    } catch (error) {
      opts.log(`업데이트 확인 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  void checkNow();
  const cancel = (opts.schedule ?? defaultSchedule)(() => { void checkNow(); }, opts.intervalMs ?? UPDATE_INTERVAL_MS);
  return { checkNow, stop: cancel };
}
