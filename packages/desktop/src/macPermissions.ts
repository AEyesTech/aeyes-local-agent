/**
 * macOS 권한 안내. 화면 기록(screenshot)과 손쉬운 사용(마우스·키보드)은 사용자가 시스템 설정에서 직접 켜야 한다.
 * 확인만 하고(프롬프트 없이) 설정 화면을 열어 준다. 첫 실행 여부는 userData 의 desktop-state.json 에 둔다.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type MacPermission = 'accessibility' | 'screen';

export interface PermissionProbe {
  isTrustedAccessibilityClient(prompt: boolean): boolean;
  getMediaAccessStatus(mediaType: 'screen'): string;
}

export const MAC_SETTINGS_URLS: Record<MacPermission, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

export function missingMacPermissions(platform: NodeJS.Platform, probe: PermissionProbe): MacPermission[] {
  if (platform !== 'darwin') return [];
  const missing: MacPermission[] = [];
  if (!probe.isTrustedAccessibilityClient(false)) missing.push('accessibility');
  if (probe.getMediaAccessStatus('screen') !== 'granted') missing.push('screen');
  return missing;
}

export function permissionGuideDialog(missing: MacPermission[]): {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  actions: Array<MacPermission | null>;
} {
  const lines: string[] = [];
  const buttons: string[] = [];
  const actions: Array<MacPermission | null> = [];
  if (missing.includes('accessibility')) {
    lines.push('• 손쉬운 사용: 마우스·키보드 제어 도구에 필요합니다.');
    buttons.push('손쉬운 사용 설정 열기');
    actions.push('accessibility');
  }
  if (missing.includes('screen')) {
    lines.push('• 화면 기록: screenshot 도구가 창 내용을 캡처하려면 필요합니다.');
    buttons.push('화면 기록 설정 열기');
    actions.push('screen');
  }
  buttons.push('나중에');
  actions.push(null);
  return {
    title: 'AeyeStudio 에이전트 권한 안내',
    message: '화면·마우스·키보드 도구를 쓰려면 macOS 권한이 필요합니다.',
    detail:
      `${lines.join('\n')}\n\n시스템 설정 > 개인정보 보호 및 보안에서 "AeyeStudio Agent" 를 켠 뒤 앱을 다시 시작하세요. ` +
      '권한이 없어도 파일·엑셀·셸 도구는 그대로 쓸 수 있습니다. 트레이 메뉴에서 이 안내를 다시 볼 수 있습니다.',
    buttons,
    actions,
  };
}

export interface DesktopState {
  permissionGuideShown: boolean;
}

export async function readDesktopState(file: string): Promise<DesktopState> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { permissionGuideShown?: unknown };
    return { permissionGuideShown: raw.permissionGuideShown === true };
  } catch {
    return { permissionGuideShown: false };
  }
}

export async function writeDesktopState(file: string, state: DesktopState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state), 'utf8');
}
