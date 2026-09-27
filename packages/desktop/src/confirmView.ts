/**
 * 확인 창에 보일 내용(순수 데이터). 원격(웹)에서 온 글은 모두 core 의 정화 함수를 거친다.
 * 렌더러는 이 값을 textContent 로만 넣고, 누른 버튼 id 만 돌려준다. 제시하지 않은 버튼은 거부로 본다.
 */
import {
  CONFIRM_TIMEOUT_MS,
  SESSION_GRANT_TTL_MS,
  sanitizeForTerminal,
  truncateSummaryForDisplay,
  type ConfirmDecision,
  type ConfirmRequest,
} from 'aeyes-local-agent';

export type ConfirmButtonId = 'allow' | 'always' | 'session' | 'deny';

export interface ConfirmView {
  id: string;
  title: string;
  account: string;
  origin: string;
  tool: string;
  summary: string;
  buttons: Array<{ id: ConfirmButtonId; label: string }>;
  timeoutSec: number;
  /** 창이 뜬 뒤 버튼을 누를 수 있기까지의 지연(잘못 누르기·자동 입력 방지). */
  enableDelayMs: number;
}

export const CONFIRM_ENABLE_DELAY_MS = 1000;
const LABEL_MAX = 200;
const SUMMARY_MAX = 500;

export function buildConfirmView(id: string, req: ConfirmRequest, timeoutSec: number = CONFIRM_TIMEOUT_MS / 1000): ConfirmView {
  const buttons: ConfirmView['buttons'] = [{ id: 'allow', label: '허용' }];
  if (req.alwaysAllowed === true && req.grantKey) {
    buttons.push({ id: 'always', label: `항상 허용 (범위: ${sanitizeForTerminal(req.grantKey, LABEL_MAX)})` });
  }
  if (req.sessionAllowed === true) {
    buttons.push({ id: 'session', label: `이 세션 동안 허용 (마우스·키보드, ${SESSION_GRANT_TTL_MS / 60_000}분)` });
  }
  buttons.push({ id: 'deny', label: '거부' });
  return {
    id,
    title: 'AeyeStudio — PC 확인 필요',
    account: sanitizeForTerminal(req.accountLabel || 'AeyeStudio', LABEL_MAX),
    origin: sanitizeForTerminal(req.origin, LABEL_MAX),
    tool: sanitizeForTerminal(req.tool, LABEL_MAX),
    summary: truncateSummaryForDisplay(sanitizeForTerminal(req.summary), SUMMARY_MAX),
    buttons,
    timeoutSec: Math.round(timeoutSec),
    enableDelayMs: CONFIRM_ENABLE_DELAY_MS,
  };
}

const DECISIONS: Record<ConfirmButtonId, ConfirmDecision> = { allow: 'allow', always: 'always', session: 'session', deny: 'deny' };

export function decisionFor(view: ConfirmView, button: unknown): ConfirmDecision {
  if (typeof button !== 'string') return 'deny';
  const offered = view.buttons.find((b) => b.id === button);
  return offered ? DECISIONS[offered.id] : 'deny';
}
