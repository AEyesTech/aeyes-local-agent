/**
 * "새 기기 연결" 코드 창(네이티브 메시지 상자)과 연결 알림 문구.
 */
import type { PairingRecord } from 'aeyes-local-agent';
import { pairingLabel } from './trayMenu.js';

export interface PairingDialogSpec {
  type: 'info';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: true;
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** 버튼: 0 = 코드 복사, 1 = 새 코드, 2 = 닫기. */
export function pairingDialogOptions(code: string, expiresAt: number, now: number = Date.now()): PairingDialogSpec {
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  return {
    type: 'info',
    title: '새 기기 연결',
    message: `페어링 코드: ${formatPairingCode(code)}`,
    detail: `AeyeStudio 설정 > 내 PC 연결에 입력하세요. ${minutes}분 동안 한 번만 쓸 수 있습니다.`,
    buttons: ['코드 복사', '새 코드', '닫기'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}

export function pairedNotice(record: PairingRecord): { title: string; body: string } {
  return { title: 'AeyeStudio 에이전트', body: `연결됨: ${pairingLabel(record)}` };
}
