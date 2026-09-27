/**
 * 트레이 메뉴 템플릿(순수 함수). 클릭할 때마다 최신 상태로 새로 만든다.
 * 원격에서 온 라벨(계정·브라우저)은 정화하고, Windows 메뉴의 & 단축키 표시를 막으려고 && 로 바꾼다.
 */
import type { MenuItemConstructorOptions } from 'electron';
import { sanitizeForTerminal, type AgentConfig, type PairingRecord } from 'aeyes-local-agent';

export interface TrayState {
  version: string;
  port: number;
  config: AgentConfig;
  sessionGrantCount: number;
  openAtLogin: boolean;
  platform: NodeJS.Platform;
}

export interface TrayActions {
  showPairingCode(): void;
  revokePairing(id: string): void;
  revokeAllPairings(): void;
  openFolder(dir: string): void;
  addAllowedDir(): void;
  removeAllowedDir(dir: string): void;
  removeAlwaysAllow(key: string): void;
  resetAlwaysAllow(): void;
  clearSessionGrants(): void;
  openAuditLog(): void;
  showPermissionGuide(): void;
  setOpenAtLogin(enabled: boolean): void;
  checkForUpdates(): void;
  quit(): void;
}

const LABEL_MAX = 60;

export function pairingLabel(record: PairingRecord): string {
  const account = sanitizeForTerminal(record.accountLabel || '(계정 정보 없음)', LABEL_MAX);
  const browser = sanitizeForTerminal(record.browserLabel || '브라우저', LABEL_MAX);
  return `${account} · ${browser}`;
}

function menuText(text: string): string {
  return text.replace(/&/g, '&&');
}

export function buildTrayMenu(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  const { config } = state;

  const pairings: MenuItemConstructorOptions[] = config.pairings.length === 0
    ? [{ label: '연결된 브라우저 없음', enabled: false }]
    : [
        ...config.pairings.map((p): MenuItemConstructorOptions => ({
          label: menuText(pairingLabel(p)),
          submenu: [
            {
              label: `연결: ${p.createdAt.slice(0, 10)}${p.lastUsedAt ? ` · 마지막 사용: ${p.lastUsedAt.slice(0, 10)}` : ''}`,
              enabled: false,
            },
            { label: '연결 해제', click: () => actions.revokePairing(p.id) },
          ],
        })),
        { type: 'separator' },
        { label: '모두 해제', click: () => actions.revokeAllPairings() },
      ];

  const onlyOneDir = config.allowedDirs.length <= 1;
  const dirs: MenuItemConstructorOptions[] = [
    ...config.allowedDirs.map((dir): MenuItemConstructorOptions => ({
      label: menuText(sanitizeForTerminal(dir, 200)),
      submenu: [
        { label: '폴더 열기', click: () => actions.openFolder(dir) },
        {
          label: onlyOneDir ? '목록에서 제거(마지막 폴더는 제거할 수 없음)' : '목록에서 제거',
          enabled: !onlyOneDir,
          click: () => actions.removeAllowedDir(dir),
        },
      ],
    })),
    { type: 'separator' },
    { label: '폴더 추가…', click: () => actions.addAllowedDir() },
  ];

  const grants: MenuItemConstructorOptions[] = config.alwaysAllow.length === 0
    ? [{ label: '항상 허용 없음', enabled: false }]
    : [
        ...config.alwaysAllow.map((g): MenuItemConstructorOptions => ({
          label: menuText(sanitizeForTerminal(g.key, 200)),
          submenu: [{ label: '제거', click: () => actions.removeAlwaysAllow(g.key) }],
        })),
        { type: 'separator' },
        { label: '모두 초기화', click: () => actions.resetAlwaysAllow() },
      ];

  const macOnly: MenuItemConstructorOptions[] = state.platform === 'darwin'
    ? [{ label: '화면 기록·손쉬운 사용 권한 안내…', click: () => actions.showPermissionGuide() }]
    : [];

  return [
    { label: `AeyeStudio 에이전트 ${state.version} — 실행 중 (127.0.0.1:${state.port})`, enabled: false },
    { type: 'separator' },
    { label: '새 기기 연결…', click: () => actions.showPairingCode() },
    { label: `연결된 브라우저 (${config.pairings.length})`, submenu: pairings },
    { label: `허용 폴더 (${config.allowedDirs.length})`, submenu: dirs },
    { label: `항상 허용 (${config.alwaysAllow.length})`, submenu: grants },
    {
      label: `이 세션 동안 허용 취소 (${state.sessionGrantCount})`,
      enabled: state.sessionGrantCount > 0,
      click: () => actions.clearSessionGrants(),
    },
    { type: 'separator' },
    { label: '감사 로그 열기', click: () => actions.openAuditLog() },
    ...macOnly,
    {
      label: '로그인 시 자동 실행',
      type: 'checkbox',
      checked: state.openAtLogin,
      click: (item) => actions.setOpenAtLogin(item.checked),
    },
    { label: '업데이트 확인', click: () => actions.checkForUpdates() },
    { type: 'separator' },
    { label: '종료', click: () => actions.quit() },
  ];
}
