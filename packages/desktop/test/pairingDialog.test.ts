import { describe, expect, it } from 'vitest';
import { formatPairingCode, pairedNotice, pairingDialogOptions } from '../src/pairingDialog.js';

describe('pairingDialog', () => {
  it('코드는 3자리씩 띄우고 남은 분을 보여 준다', () => {
    expect(formatPairingCode('123456')).toBe('123 456');
    const now = 1_000_000;
    const spec = pairingDialogOptions('123456', now + 4 * 60_000 + 1, now);
    expect(spec.message).toBe('페어링 코드: 123 456');
    expect(spec.detail).toContain('5분');
    expect(spec.buttons).toEqual(['코드 복사', '새 코드', '닫기']);
    expect(spec).toMatchObject({ type: 'info', defaultId: 0, cancelId: 2, noLink: true });
    expect(pairingDialogOptions('000001', now - 1, now).detail).toContain('0분');
  });

  it('연결 알림은 정화된 라벨', () => {
    expect(pairedNotice({ id: 'p', tokenHash: 'h', accountLabel: 'ky***@gmail.com', browserLabel: 'Chrome\n', createdAt: 'x', lastUsedAt: null }))
      .toEqual({ title: 'AeyeStudio 에이전트', body: '연결됨: ky***@gmail.com · Chrome⏎' });
  });
});
