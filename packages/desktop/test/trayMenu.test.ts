import type { MenuItemConstructorOptions } from 'electron';
import type { AgentConfig } from 'aeyes-local-agent';
import { describe, expect, it, vi } from 'vitest';
import { buildTrayMenu, pairingLabel, type TrayActions, type TrayState } from '../src/trayMenu.js';

function actions(): TrayActions & Record<string, ReturnType<typeof vi.fn>> {
  const names = ['showPairingCode', 'revokePairing', 'revokeAllPairings', 'openFolder', 'addAllowedDir', 'removeAllowedDir',
    'removeAlwaysAllow', 'resetAlwaysAllow', 'clearSessionGrants', 'openAuditLog', 'showPermissionGuide', 'setOpenAtLogin',
    'checkForUpdates', 'quit'];
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as unknown as TrayActions & Record<string, ReturnType<typeof vi.fn>>;
}

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  port: 47821, allowedDirs: ['/Users/a/Documents/AeyeStudio'], pairings: [], alwaysAllow: [], databases: [], ...over,
});
const state = (over: Partial<TrayState> = {}): TrayState => ({
  version: '0.2.0', port: 47821, config: config(), sessionGrantCount: 0, openAtLogin: false, platform: 'darwin', ...over,
});

function find(items: MenuItemConstructorOptions[], prefix: string): MenuItemConstructorOptions {
  for (const item of items) {
    if (typeof item.label === 'string' && item.label.startsWith(prefix)) return item;
    if (Array.isArray(item.submenu)) {
      try { return find(item.submenu, prefix); } catch { /* 다음 */ }
    }
  }
  throw new Error(`메뉴 없음: ${prefix}`);
}
const click = (item: MenuItemConstructorOptions, checked = false) =>
  (item.click as unknown as (m: { checked: boolean }) => void)({ checked });

describe('buildTrayMenu', () => {
  it('상태 줄과 기본 항목', () => {
    const a = actions();
    const items = buildTrayMenu(state(), a);
    expect(items[0]).toMatchObject({ label: 'AeyeStudio 에이전트 0.2.0 — 실행 중 (127.0.0.1:47821)', enabled: false });
    click(find(items, '새 기기 연결'));
    click(find(items, '감사 로그 열기'));
    click(find(items, '업데이트 확인'));
    click(find(items, '종료'));
    expect(a.showPairingCode).toHaveBeenCalled();
    expect(a.openAuditLog).toHaveBeenCalled();
    expect(a.checkForUpdates).toHaveBeenCalled();
    expect(a.quit).toHaveBeenCalled();
    expect(find(items, '연결된 브라우저 없음').enabled).toBe(false);
    expect(find(items, '항상 허용 없음').enabled).toBe(false);
  });

  it('연결 목록: 해제·모두 해제, 라벨은 정화하고 & 를 이스케이프', () => {
    const a = actions();
    const pairings = [{ id: 'p1', tokenHash: 'h', accountLabel: 'ky***@gmail.com', browserLabel: 'Chrome & Co\u001b', createdAt: '2026-09-27T00:00:00Z', lastUsedAt: null }];
    const items = buildTrayMenu(state({ config: config({ pairings }) }), a);
    expect(find(items, '연결된 브라우저 (1)')).toBeTruthy();
    const entry = find(items, 'ky***@gmail.com');
    expect(entry.label).toBe('ky***@gmail.com · Chrome && Co\\x1b');
    click(find(entry.submenu as MenuItemConstructorOptions[], '연결 해제'));
    expect(a.revokePairing).toHaveBeenCalledWith('p1');
    click(find(items, '모두 해제'));
    expect(a.revokeAllPairings).toHaveBeenCalled();
  });

  it('허용 폴더: 마지막 하나는 제거 불가, 둘 이상이면 제거 가능', () => {
    const a = actions();
    const one = buildTrayMenu(state(), a);
    expect(find(one, '목록에서 제거').enabled).toBe(false);
    const two = buildTrayMenu(state({ config: config({ allowedDirs: ['/a', '/b'] }) }), a);
    const remove = find(find(two, '/b').submenu as MenuItemConstructorOptions[], '목록에서 제거');
    expect(remove.enabled).toBe(true);
    click(remove);
    expect(a.removeAllowedDir).toHaveBeenCalledWith('/b');
    click(find(two, '폴더 열기'));
    expect(a.openFolder).toHaveBeenCalledWith('/a');
    click(find(two, '폴더 추가'));
    expect(a.addAllowedDir).toHaveBeenCalled();
  });

  it('항상 허용 목록: 제거·모두 초기화, 세션 허용 취소는 개수가 있을 때만', () => {
    const a = actions();
    const items = buildTrayMenu(state({
      config: config({ alwaysAllow: [{ key: 'shell_exec:git', createdAt: 'x' }] }),
      sessionGrantCount: 2,
    }), a);
    click(find(find(items, 'shell_exec:git').submenu as MenuItemConstructorOptions[], '제거'));
    expect(a.removeAlwaysAllow).toHaveBeenCalledWith('shell_exec:git');
    click(find(items, '모두 초기화'));
    expect(a.resetAlwaysAllow).toHaveBeenCalled();
    const session = find(items, '이 세션 동안 허용 취소 (2)');
    expect(session.enabled).toBe(true);
    click(session);
    expect(a.clearSessionGrants).toHaveBeenCalled();
    expect(find(buildTrayMenu(state(), a), '이 세션 동안 허용 취소 (0)').enabled).toBe(false);
  });

  it('로그인 시 자동 실행 체크박스와 macOS 전용 권한 안내', () => {
    const a = actions();
    const mac = buildTrayMenu(state({ openAtLogin: true }), a);
    const login = find(mac, '로그인 시 자동 실행');
    expect(login).toMatchObject({ type: 'checkbox', checked: true });
    click(login, false);
    expect(a.setOpenAtLogin).toHaveBeenCalledWith(false);
    click(find(mac, '화면 기록·손쉬운 사용 권한 안내'));
    expect(a.showPermissionGuide).toHaveBeenCalled();
    expect(() => find(buildTrayMenu(state({ platform: 'win32' }), a), '화면 기록·손쉬운 사용 권한 안내')).toThrow();
  });
});

describe('pairingLabel', () => {
  it('빈 라벨은 대체 문구', () => {
    expect(pairingLabel({ id: 'x', tokenHash: 'h', accountLabel: '', browserLabel: '', createdAt: 'x', lastUsedAt: null }))
      .toBe('(계정 정보 없음) · 브라우저');
  });
});
