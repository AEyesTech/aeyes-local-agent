/**
 * Electron 메인 프로세스 셸. 로직은 테스트된 모듈(confirmView·desktopConfirmer·trayMenu·settingsActions·
 * pairingDialog·instance·macPermissions·updater·trayIcon)에 있고, 여기서는 Electron API 와 연결만 한다.
 */
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell, systemPreferences, Tray,
  type IpcMainEvent,
} from 'electron';
import electronUpdater from 'electron-updater';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentAlreadyRunningError, AGENT_VERSION, ConfigStore, defaultConfigDir, PID_FILE, readRunningPid, removePidFile, startAgent, writePidFile,
  type RunningAgent,
} from 'aeyes-local-agent';
import type { ConfirmView } from './confirmView.js';
import { DesktopConfirmer, type ConfirmWindowHandle } from './desktopConfirmer.js';
import { acquireInstance } from './instance.js';
import { MAC_SETTINGS_URLS, missingMacPermissions, permissionGuideDialog, readDesktopState, writeDesktopState } from './macPermissions.js';
import { pairedNotice, pairingDialogOptions } from './pairingDialog.js';
import { addAllowedDir, removeAllowedDir, removeAlwaysAllow, resetAlwaysAllow } from './settingsActions.js';
import { buildTrayMenu, type TrayActions } from './trayMenu.js';
import { trayImage } from './trayIcon.js';
import { startAutoUpdate } from './updater.js';

const { autoUpdater } = electronUpdater;
const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
const TITLE = 'AeyeStudio 에이전트';

/** GC 로 트레이가 사라지지 않게 모듈 범위에 둔다. */
let tray: Tray | null = null;
let cleanup: (() => Promise<void>) | null = null;
let quitting = false;

function openConfirmWindow(view: ConfirmView): ConfirmWindowHandle {
  const win = new BrowserWindow({
    width: 480,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    autoHideMenuBar: true,
    title: view.title,
    webPreferences: {
      preload: path.join(staticDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  let settle: (button: string | null) => void = () => undefined;
  const result = new Promise<string | null>((resolve) => { settle = resolve; });
  const onDecide = (event: IpcMainEvent, payload: unknown) => {
    if (win.isDestroyed() || event.sender !== win.webContents) return;
    const data = payload as { id?: unknown; button?: unknown } | null;
    if (!data || data.id !== view.id) return;
    settle(typeof data.button === 'string' ? data.button : null);
    close();
  };
  const close = () => {
    ipcMain.removeListener('confirm:decide', onDecide);
    if (!win.isDestroyed()) win.destroy();
  };
  ipcMain.on('confirm:decide', onDecide);
  win.on('closed', () => {
    ipcMain.removeListener('confirm:decide', onDecide);
    settle(null);
  });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('confirm:show', view);
    // 포커스를 빼앗지 않는다 — 사용자가 치던 키가 확인 창으로 들어가지 않게.
    win.showInactive();
    win.flashFrame(true);
  });
  win.loadFile(path.join(staticDir, 'confirm.html')).catch((error: unknown) => {
    // 확인 창을 띄우지 못하면 거부로 끝내고 창을 닫는다.
    console.error('[aeyes-agent-desktop] 확인 창을 열 수 없습니다', error);
    settle(null);
    close();
  });
  return { result, close };
}

async function showPairingCode(agent: RunningAgent): Promise<void> {
  for (;;) {
    const { code, expiresAt } = agent.pairing.createCode();
    const { response } = await dialog.showMessageBox(pairingDialogOptions(code, expiresAt));
    if (response === 0) {
      clipboard.writeText(code);
      return;
    }
    if (response !== 1) return;
  }
}

async function showPermissionGuide(force: boolean): Promise<void> {
  const missing = missingMacPermissions(process.platform, systemPreferences);
  if (missing.length === 0) {
    if (force) await dialog.showMessageBox({ type: 'info', title: TITLE, message: '화면 기록·손쉬운 사용 권한이 모두 허용되어 있습니다.' });
    return;
  }
  const guide = permissionGuideDialog(missing);
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: guide.title,
    message: guide.message,
    detail: guide.detail,
    buttons: guide.buttons,
    defaultId: 0,
    cancelId: guide.buttons.length - 1,
    noLink: true,
  });
  const target = guide.actions[response];
  if (target) await shell.openExternal(MAC_SETTINGS_URLS[target]);
}

async function pickAllowedDir(store: ConfigStore): Promise<void> {
  const picked = await dialog.showOpenDialog({ title: '허용 폴더 추가', properties: ['openDirectory', 'createDirectory'] });
  if (picked.canceled || picked.filePaths.length === 0) return;
  const result = await addAllowedDir(store, picked.filePaths[0]);
  if (!result.ok) dialog.showErrorBox(TITLE, result.reason);
}

/** 트레이 동작 실패를 로그로 남기고 사용자에게 알린다. */
function reportActionError(action: string): (error: unknown) => void {
  return (error: unknown) => {
    console.error(`[aeyes-agent-desktop] ${action} 실패`, error);
    dialog.showErrorBox(TITLE, `${action}에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
  };
}

function notify(text: { title: string; body: string }): void {
  if (Notification.isSupported()) new Notification(text).show();
}

async function boot(): Promise<void> {
  if (process.platform === 'darwin') app.dock?.hide();
  if (process.platform === 'win32') app.setAppUserModelId('dev.aeyes.agent');

  const configDir = defaultConfigDir();
  const instance = await acquireInstance(configDir, {
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    readRunningPid: (dir) => readRunningPid(dir),
    pid: process.pid,
  });
  if (!instance.ok) {
    if (instance.reason === 'agent_running') {
      dialog.showErrorBox(TITLE, `이미 에이전트가 실행 중입니다(pid ${instance.pid}). 터미널의 npx 에이전트를 먼저 종료한 뒤 다시 실행하세요. 실제로 실행 중인 에이전트가 없다면 ${path.join(configDir, PID_FILE)} 파일을 지운 뒤 다시 실행하세요.`);
    }
    app.exit(0);
    return;
  }

  let store: ConfigStore;
  try {
    store = await ConfigStore.open(configDir);
  } catch (error) {
    dialog.showErrorBox(TITLE, error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }
  try {
    await writePidFile(store.dir);
  } catch (error) {
    // 시작 검사 뒤에 터미널 에이전트가 먼저 pid 파일을 만든 경우(경합) 등.
    dialog.showErrorBox(TITLE, error instanceof AgentAlreadyRunningError
      ? `${error.message} 터미널의 npx 에이전트를 먼저 종료한 뒤 다시 실행하세요.`
      : `pid 파일을 만들 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(error instanceof AgentAlreadyRunningError ? 0 : 1);
    return;
  }

  const confirmer = new DesktopConfirmer(openConfirmWindow);
  let agent: RunningAgent;
  try {
    agent = await startAgent({ store, confirmer, onPaired: (record) => notify(pairedNotice(record)) });
  } catch (error) {
    await removePidFile(store.dir).catch(() => undefined);
    const busy = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE';
    dialog.showErrorBox(TITLE, busy
      ? '포트 47821~47830 이 모두 사용 중이라 시작할 수 없습니다.'
      : `에이전트를 시작할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
    return;
  }

  const updates = startAutoUpdate(autoUpdater, {
    isPackaged: app.isPackaged,
    log: (message) => console.log('[aeyes-agent-desktop]', message),
  });
  cleanup = async () => {
    updates.stop();
    confirmer.closeAll();
    await agent.close().catch(() => undefined);
    await removePidFile(store.dir).catch(() => undefined);
  };

  const actions: TrayActions = {
    showPairingCode: () => { showPairingCode(agent).catch(reportActionError('페어링 코드 표시')); },
    revokePairing: (id) => { agent.pairing.revoke(id).catch(reportActionError('연결 해제')); },
    revokeAllPairings: () => { agent.pairing.revokeAll().catch(reportActionError('모든 연결 해제')); },
    openFolder: (dir) => {
      shell.openPath(dir).then((error) => {
        if (error) dialog.showErrorBox(TITLE, `폴더를 열 수 없습니다: ${error}`);
      }).catch(reportActionError('폴더 열기'));
    },
    addAllowedDir: () => { pickAllowedDir(store).catch(reportActionError('허용 폴더 추가')); },
    removeAllowedDir: (dir) => {
      removeAllowedDir(store, dir).then((r) => { if (!r.ok) dialog.showErrorBox(TITLE, r.reason); })
        .catch(reportActionError('허용 폴더 제거'));
    },
    removeAlwaysAllow: (key) => { removeAlwaysAllow(store, key).catch(reportActionError('항상 허용 제거')); },
    resetAlwaysAllow: () => { resetAlwaysAllow(store).catch(reportActionError('항상 허용 초기화')); },
    clearSessionGrants: () => { agent.clearSessionGrants(); },
    openAuditLog: () => {
      shell.openPath(path.join(store.dir, 'audit.log')).then((error) => {
        if (error) dialog.showErrorBox(TITLE, '아직 감사 로그가 없습니다. 도구가 한 번이라도 호출되면 생깁니다.');
      }).catch(reportActionError('감사 로그 열기'));
    },
    showPermissionGuide: () => { showPermissionGuide(true).catch(reportActionError('권한 안내')); },
    setOpenAtLogin: (enabled) => { app.setLoginItemSettings({ openAtLogin: enabled }); },
    checkForUpdates: () => { updates.checkNow().catch(reportActionError('업데이트 확인')); },
    quit: () => { app.quit(); },
  };

  tray = new Tray(trayImage(process.platform, nativeImage));
  tray.setToolTip(`${TITLE} — 127.0.0.1:${agent.port}`);
  const popUp = () => {
    const menu = Menu.buildFromTemplate(buildTrayMenu({
      version: AGENT_VERSION,
      port: agent.port,
      config: store.get(),
      sessionGrantCount: agent.sessionGrantCount(),
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      platform: process.platform,
    }, actions));
    tray?.popUpContextMenu(menu);
  };
  tray.on('click', popUp);
  tray.on('right-click', popUp);
  app.on('second-instance', () => { showPairingCode(agent).catch(reportActionError('페어링 코드 표시')); });

  if (process.platform === 'darwin') {
    const stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
    const state = await readDesktopState(stateFile);
    if (!state.permissionGuideShown) {
      await writeDesktopState(stateFile, { ...state, permissionGuideShown: true });
      await showPermissionGuide(false);
    }
  }
  if (store.get().pairings.length === 0) showPairingCode(agent).catch(reportActionError('페어링 코드 표시'));
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
// 트레이 앱은 창이 모두 닫혀도 계속 실행된다(리스너가 있으면 기본 종료가 일어나지 않는다).
app.on('window-all-closed', () => undefined);
app.on('before-quit', (event) => {
  if (quitting || !cleanup) return;
  event.preventDefault();
  quitting = true;
  void cleanup().finally(() => app.quit());
});

app.whenReady().then(boot).catch((error: unknown) => {
  dialog.showErrorBox(TITLE, error instanceof Error ? error.message : String(error));
  app.exit(1);
});
