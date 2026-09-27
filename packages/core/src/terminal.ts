/**
 * 터미널 입출력: 로컬 확인 프롬프트와 대화형 명령(p/u/q)을 한 입력 스트림으로 처리한다.
 * 확인은 큐로 한 번에 하나씩 보여 주고, 대기 중인 확인이 있으면 입력 줄은 그 답이 된다.
 * 허용하려면 프롬프트마다 새로 뽑은 2자리 코드(10~99)를 입력해야 한다("47" 이번만, "47a" 항상, "47s" 세션).
 * 그 밖의 입력(y·a 포함)은 모두 거부 — 자동 입력(keyboard_type 등)이 미리 쳐 둔 "y" 로 확인을 통과하지 못하게.
 * 프롬프트가 뜨기 전에 들어와 있던 입력과 뜬 직후 PROMPT_INPUT_GRACE_MS 안에 도착한 줄은 버린다.
 */
import { randomInt } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { ConfirmDecision, Confirmer, ConfirmRequest } from './policy/confirmer.js';
import { SESSION_GRANT_TTL_MS } from './policy/gate.js';

/** 확인 요약을 앞뒤 절반씩 보여 주는 최대 길이. db_query 쓰기 문은 이 안에 다 들어와야 한다. */
export const SUMMARY_DISPLAY_MAX = 500;
/** 화면에 떠 있는 확인 외에 줄 세워 둘 수 있는 확인 수. 넘치면(요청 폭주) 새 확인은 즉시 거부한다. */
export const MAX_QUEUED_CONFIRMATIONS = 10;
const LABEL_DISPLAY_MAX = 200;
/** 프롬프트가 뜬 뒤 이 시간 안에 도착한 줄은 답으로 보지 않는다(미리 버퍼에 쌓여 있던 입력일 수 있다). */
export const PROMPT_INPUT_GRACE_MS = 300;

export interface TerminalIOOptions {
  /** 시계(테스트용). */
  now?: () => number;
  /** 확인 코드 생성기(테스트용). 기본은 crypto.randomInt(10, 100). */
  code?: () => number;
}

/** 확인 코드: 10~99 의 2자리 수. */
export function randomConfirmCode(): number {
  return randomInt(10, 100);
}

/**
 * 원격(웹)에서 온 글을 터미널에 보이기 전에 정화한다. 확인 프롬프트는 마지막 방어선이라
 * 커서 이동·화면 지우기(ESC), 줄바꿈으로 가짜 프롬프트 만들기, 양방향 문자로 글자 순서 뒤집기를 모두 막는다.
 * C0/C1 제어 문자·DEL 은 \xHH, 줄바꿈은 ⏎, 양방향 제어 문자는 \uHHHH 로 보인다.
 */
export function sanitizeForTerminal(text: string, max?: number): string {
  const escaped = String(text).replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (c) => {
      if (c === '\n') return '⏎';
      const code = c.charCodeAt(0);
      return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
    }
  );
  if (max === undefined) return escaped;
  const chars = Array.from(escaped);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : escaped;
}

/**
 * 확인 프롬프트의 요약(summary)은 마지막 방어선이라 앞부분만 보여 주면 위험한 꼬리(`; rm -rf ~` 등)를
 * 가릴 수 있다. `max` 를 넘으면 앞뒤를 절반씩 보여 주고 잘렸다는 사실과 전체 길이를 함께 표시한다.
 * 입력은 이미 sanitizeForTerminal 로 이스케이프된 문자열이어야 한다(이스케이프가 잘리지 않도록).
 */
export function truncateSummaryForDisplay(escaped: string, max: number): string {
  const chars = Array.from(escaped);
  if (chars.length <= max) return escaped;
  const half = Math.floor(max / 2);
  const head = chars.slice(0, half).join('');
  const tail = chars.slice(chars.length - half).join('');
  return `${head} … ${tail} (총 ${chars.length}자)`;
}

interface Pending {
  req: ConfirmRequest;
  signal: AbortSignal;
  resolve(decision: ConfirmDecision): void;
  onAbort?: () => void;
  /** 화면에 뜬 뒤 정해진다. */
  code?: string;
  shownAt?: number;
  ignoredNoticeShown?: boolean;
}

export class TerminalIO implements Confirmer {
  private readonly rl: Interface;
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private commandHandler: ((line: string) => void) | null = null;
  private closed = false;
  private explicitClose = false;
  private readonly now: () => number;
  private readonly nextCode: () => number;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    opts: TerminalIOOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
    this.nextCode = opts.code ?? randomConfirmCode;
    this.rl = createInterface({ input, terminal: false });
    this.rl.on('line', (line) => this.onLine(line.trim(), this.now()));
    this.rl.on('close', () => this.onClosed());
  }

  onCommand(handler: (line: string) => void): void {
    this.commandHandler = handler;
  }

  confirm(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmDecision> {
    if (this.closed) return Promise.resolve('deny');
    if (signal.aborted) return Promise.resolve('deny');
    if (this.queue.length >= MAX_QUEUED_CONFIRMATIONS) {
      this.output.write('\n(확인 대기가 너무 많아 새 요청을 거부했습니다)\n');
      return Promise.resolve('deny');
    }
    return new Promise((resolve) => {
      const pending: Pending = { req, signal, resolve };
      pending.onAbort = () => this.finish(pending, 'deny', '\n(시간 초과로 거부했습니다)\n');
      signal.addEventListener('abort', pending.onAbort, { once: true });
      this.queue.push(pending);
      this.showNext();
    });
  }

  close(): void {
    this.explicitClose = true;
    for (const pending of [...this.queue, ...(this.active ? [this.active] : [])]) {
      if (pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve('deny');
    }
    this.queue.length = 0;
    this.active = null;
    this.rl.close();
  }

  /** stdin 이 닫히면(EOF, 파이프 종료 등) 대기 중인 확인은 모두 거부하고, 이후 확인 요청도 즉시 거부한다.
   *  에이전트 자체는 계속 실행되어야 하므로 여기서 프로세스를 종료하지 않는다. */
  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.queue, ...(this.active ? [this.active] : [])]) {
      if (pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve('deny');
    }
    this.queue.length = 0;
    this.active = null;
    if (!this.explicitClose) {
      this.output.write('터미널 입력이 닫혀 로컬 확인이 필요한 요청은 모두 거부됩니다.\n');
    }
  }

  private showNext(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    const { req } = next;
    const code = String(this.nextCode());
    next.code = code;
    // 프롬프트 이전에 쌓인 입력은 답이 아니다. TTY 면 대기 중인 입력을 비우고(비운 줄도 유예 시간 안이라 버려진다),
    // 그렇지 않아도 유예 시간 안에 도착한 줄은 버린다.
    next.shownAt = this.now();
    this.drainPendingInput();
    const always = req.alwaysAllowed === true && req.grantKey
      ? `  [${code}a] 항상 허용 (범위: ${sanitizeForTerminal(req.grantKey, LABEL_DISPLAY_MAX)})`
      : '';
    const session = req.sessionAllowed === true
      ? `  [${code}s] 이 세션 동안 허용(마우스·키보드, ${SESSION_GRANT_TTL_MS / 60_000}분)`
      : '';
    const account = sanitizeForTerminal(req.accountLabel || 'AeyeStudio', LABEL_DISPLAY_MAX);
    const origin = sanitizeForTerminal(req.origin, LABEL_DISPLAY_MAX);
    this.output.write(
      `\n[확인 필요] ${account} (${origin})\n` +
      `  ${sanitizeForTerminal(req.tool, LABEL_DISPLAY_MAX)}: ${truncateSummaryForDisplay(sanitizeForTerminal(req.summary), SUMMARY_DISPLAY_MAX)}\n` +
      `  허용하려면 코드를 입력하세요 — [${code}] 이번만 허용${always}${session}  [그 외] 거부 > `
    );
  }

  /** TTY 에 이미 들어와 있는 입력을 읽어 버린다(읽힌 줄은 onLine 에서 유예 시간 안이라 버려진다). */
  private drainPendingInput(): void {
    const stream = this.input as NodeJS.ReadableStream & Partial<Pick<Readable, 'read'>> & { isTTY?: boolean };
    if (stream.isTTY !== true || typeof stream.read !== 'function') return;
    try {
      for (let i = 0; i < 1000 && stream.read() !== null; i += 1) {
        // 버린다.
      }
    } catch {
      // 비우지 못해도 유예 시간 규칙이 남아 있다.
    }
  }

  private onLine(line: string, arrivedAt: number): void {
    const active = this.active;
    if (active) {
      if (arrivedAt < (active.shownAt ?? 0) + PROMPT_INPUT_GRACE_MS) {
        // 프롬프트가 뜨기 전·직후에 쌓여 있던 입력 — 답으로 보지 않는다.
        if (!active.ignoredNoticeShown) {
          active.ignoredNoticeShown = true;
          this.output.write('\n(확인이 뜨기 전에 들어온 입력은 무시했습니다. 코드를 다시 입력하세요) > ');
        }
        return;
      }
      const answer = line.toLowerCase();
      const code = active.code ?? '';
      // "항상 허용"·"세션 허용"은 그 선택지를 제시한 경우에만 받는다. 그 밖의 모든 입력은 거부.
      const canAlways = active.req.alwaysAllowed === true && !!active.req.grantKey;
      const canSession = active.req.sessionAllowed === true;
      const decision: ConfirmDecision =
        code === '' ? 'deny'
          : answer === code ? 'allow'
            : answer === `${code}a` && canAlways ? 'always'
              : answer === `${code}s` && canSession ? 'session'
                : 'deny';
      this.finish(active, decision, decision === 'deny' ? '거부했습니다.\n' : '허용했습니다.\n');
      return;
    }
    if (line) this.commandHandler?.(line);
  }

  private finish(pending: Pending, decision: ConfirmDecision, message: string): void {
    if (pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    const index = this.queue.indexOf(pending);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.active === pending) {
      this.active = null;
      this.output.write(message);
    }
    pending.resolve(decision);
    this.showNext();
  }
}
