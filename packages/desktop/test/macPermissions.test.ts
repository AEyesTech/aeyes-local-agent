import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAC_SETTINGS_URLS, missingMacPermissions, permissionGuideDialog, readDesktopState, writeDesktopState,
} from '../src/macPermissions.js';

const probe = (trusted: boolean, screen: string) => ({
  isTrustedAccessibilityClient: (prompt: boolean) => { if (prompt) throw new Error('묻지 않아야 한다'); return trusted; },
  getMediaAccessStatus: () => screen,
});

describe('missingMacPermissions', () => {
  it('macOS 에서만 빠진 권한을 알려 준다(프롬프트 없이)', () => {
    expect(missingMacPermissions('darwin', probe(false, 'denied'))).toEqual(['accessibility', 'screen']);
    expect(missingMacPermissions('darwin', probe(true, 'not-determined'))).toEqual(['screen']);
    expect(missingMacPermissions('darwin', probe(true, 'granted'))).toEqual([]);
    expect(missingMacPermissions('win32', probe(false, 'denied'))).toEqual([]);
  });
});

describe('permissionGuideDialog', () => {
  it('빠진 권한마다 설정 열기 버튼과 나중에', () => {
    const d = permissionGuideDialog(['accessibility', 'screen']);
    expect(d.buttons).toEqual(['손쉬운 사용 설정 열기', '화면 기록 설정 열기', '나중에']);
    expect(d.actions).toEqual(['accessibility', 'screen', null]);
    expect(d.detail).toContain('손쉬운 사용');
    expect(d.detail).toContain('화면 기록');
    const only = permissionGuideDialog(['screen']);
    expect(only.buttons).toEqual(['화면 기록 설정 열기', '나중에']);
    expect(MAC_SETTINGS_URLS.screen).toContain('Privacy_ScreenCapture');
    expect(MAC_SETTINGS_URLS.accessibility).toContain('Privacy_Accessibility');
  });
});

describe('desktop state', () => {
  it('없거나 깨지면 기본값, 쓰고 읽기', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-state-'));
    const file = path.join(dir, 'sub', 'desktop-state.json');
    expect(await readDesktopState(file)).toEqual({ permissionGuideShown: false });
    await writeDesktopState(file, { permissionGuideShown: true });
    expect(await readDesktopState(file)).toEqual({ permissionGuideShown: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ permissionGuideShown: true });
  });
});
