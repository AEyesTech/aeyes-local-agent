import { describe, expect, it } from 'vitest';
import { buildConfirmView, CONFIRM_ENABLE_DELAY_MS, decisionFor } from '../src/confirmView.js';

const base = { tool: 'shell_exec', summary: 'git status', origin: 'https://studio.aeyes.dev', accountLabel: 'ky***@gmail.com' };

describe('buildConfirmView', () => {
  it('항상 허용 가능 + 세션 가능이면 네 버튼, 아니면 허용·거부만', () => {
    const full = buildConfirmView('c1', { ...base, alwaysAllowed: true, grantKey: 'shell_exec:git', sessionAllowed: true });
    expect(full.buttons).toEqual([
      { id: 'allow', label: '허용' },
      { id: 'always', label: '항상 허용 (범위: shell_exec:git)' },
      { id: 'session', label: '이 세션 동안 허용 (마우스·키보드, 60분)' },
      { id: 'deny', label: '거부' },
    ]);
    expect(buildConfirmView('c2', base).buttons.map((b) => b.id)).toEqual(['allow', 'deny']);
    expect(buildConfirmView('c3', { ...base, alwaysAllowed: true }).buttons.map((b) => b.id)).toEqual(['allow', 'deny']);
  });

  it('원격 글의 제어 문자·양방향 문자를 보이는 형태로 바꾸고 긴 요약은 앞뒤를 보인다', () => {
    const v = buildConfirmView('c1', {
      ...base,
      accountLabel: 'a‮b',
      origin: 'https://x\u001b[2J',
      summary: `echo hi\n${'x'.repeat(1000)}; rm -rf ~`,
    });
    expect(v.account).toBe('a\\u202eb');
    expect(v.origin).toBe('https://x\\x1b[2J');
    expect(v.summary.startsWith('echo hi⏎')).toBe(true);
    expect(v.summary).toContain('; rm -rf ~');
    expect(v.summary).toContain('총 ');
  });

  it('계정이 비면 AeyeStudio, 기본 120초·1초 지연', () => {
    const v = buildConfirmView('c1', { ...base, accountLabel: '' });
    expect(v.account).toBe('AeyeStudio');
    expect(v.timeoutSec).toBe(120);
    expect(v.enableDelayMs).toBe(CONFIRM_ENABLE_DELAY_MS);
    expect(v.title).toBe('AeyeStudio — PC 확인 필요');
  });
});

describe('decisionFor', () => {
  it('decisionFor 는 제시하지 않은 버튼을 거부로 본다', () => {
    const plain = buildConfirmView('c1', base);
    expect(decisionFor(plain, 'allow')).toBe('allow');
    expect(decisionFor(plain, 'always')).toBe('deny');
    expect(decisionFor(plain, 'session')).toBe('deny');
    expect(decisionFor(plain, 'deny')).toBe('deny');
    expect(decisionFor(plain, 42)).toBe('deny');
    const full = buildConfirmView('c2', { ...base, alwaysAllowed: true, grantKey: 'k', sessionAllowed: true });
    expect(decisionFor(full, 'always')).toBe('always');
    expect(decisionFor(full, 'session')).toBe('session');
  });
});
