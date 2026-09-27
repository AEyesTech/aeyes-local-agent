/**
 * 위험 동작 확인: "항상 허용" 기록이 있으면 통과, 없으면 Confirmer 에 묻는다(120초 무응답은 거부).
 * "항상 허용"은 범위를 명확히 좁힐 수 있는 요청(grantKey 가 null 이 아닌 경우)에만 적용된다 —
 * 셸 제어 문자·래퍼 명령·인자가 있는 앱 실행·파일 열기·마우스/키보드·DB 쓰기는 매번 묻는다.
 * 마우스·키보드는 "이 세션 동안 허용"(메모리 전용, 페어링별, 60분)만 있다.
 * 입력 도구가 확인 창·터미널 프롬프트를 스스로 누르지 못하도록 확인 대기 중에는 입력을 막고(withInputLock),
 * 입력 동작 중에 온 확인은 입력이 끝난 뒤에 띄운다.
 */
import type { ConfigStore } from '../config.js';
import type { ConfirmDecision, Confirmer, ConfirmRequest } from './confirmer.js';

export const CONFIRM_TIMEOUT_MS = 120_000;
/** "이 세션 동안 허용"이 유지되는 최대 시간. 에이전트를 다시 시작하면 그 전에도 사라진다. */
export const SESSION_GRANT_TTL_MS = 60 * 60_000;
/** 마우스·키보드 입력 도구. "항상 허용"은 없고 "이 세션 동안 허용"만 있다. */
export const INPUT_TOOLS: ReadonlySet<string> = new Set(['mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press']);

/** 셸 제어·치환·리다이렉트·그룹 문자. 하나라도 있으면 첫 단어가 실제 실행 범위를 대표하지 못한다. */
const SHELL_CONTROL = /[;&|`$()<>{}\n\r]/;

/** 다른 명령을 대신 실행하거나 임의 코드를 해석하는 머리 명령. 이 단어 단위로 허용하면 사실상 전부 허용이 된다. */
const WRAPPER_HEADS = new Set([
  'sudo', 'doas', 'su', 'env', 'nohup', 'xargs', 'time', 'nice', 'timeout', 'watch', 'stdbuf', 'chroot',
  'exec', 'eval', 'command', 'builtin', 'source', '.', 'find', 'busybox',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh', 'cmd', 'wsl', 'runas',
  'iex', 'invoke-expression', 'invoke-command', 'icm', 'start-process',
  'node', 'deno', 'bun', 'npx', 'python', 'perl', 'ruby', 'php', 'lua', 'osascript', 'wscript', 'cscript', 'mshta',
  'open', 'start', 'rundll32', 'reg', 'schtasks', 'launchctl', 'crontab',
]);

function normalizeHead(head: string): string {
  const lower = head.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, '');
  // python3, python3.12, pythonw 등은 python 으로 본다.
  return /^python[\d.]*w?$/.test(lower) ? 'python' : lower;
}

function shellGrantKey(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL.test(trimmed) || trimmed.includes('=')) return null;
  const head = trimmed.split(/\s+/)[0] ?? '';
  // 경로가 붙은 머리(./run.sh, /usr/bin/sudo, C:\x.exe)는 내용이 바뀔 수 있고 래퍼 검사를 우회하므로 허용하지 않는다.
  if (!/^[a-z0-9._+-]+$/i.test(head)) return null;
  if (WRAPPER_HEADS.has(normalizeHead(head))) return null;
  return `shell_exec:${head.toLowerCase()}`;
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * "항상 허용"으로 기록할 키. 범위를 안전하게 좁힐 수 없는 요청이면 null — 그런 요청은 항상 목록을 보지 않고 매번 묻는다.
 */
export function grantKey(tool: string, args: Record<string, unknown>): string | null {
  // 입력 제어(세션 허용만)와 DB 쓰기(매번 확인)는 영구 허용하지 않는다.
  if (INPUT_TOOLS.has(tool) || tool === 'db_query') return null;
  if (tool === 'shell_exec') return shellGrantKey(String(args.command ?? ''));
  if (tool === 'open_path') return isWebUrl(String(args.target ?? '')) ? 'open_path:url' : null;
  if (tool === 'open_app') {
    const extra = Array.isArray(args.args) ? args.args : [];
    if (extra.length > 0) return null;
    const name = String(args.name ?? '').trim().toLowerCase();
    return name ? `open_app:${name}` : null;
  }
  return tool;
}

/** "이 세션 동안 허용" 범위 키. 입력 도구만 'input', 나머지는 null. */
export function sessionGrantKey(tool: string): string | null {
  return INPUT_TOOLS.has(tool) ? 'input' : null;
}

export class InputBlockedError extends Error {
  constructor() {
    super('PC 에서 확인 창이 떠 있는 동안에는 마우스·키보드를 제어할 수 없습니다. 확인이 끝난 뒤 다시 시도하세요');
    this.name = 'InputBlockedError';
  }
}

export interface GateRequest extends ConfirmRequest {
  /** "항상 허용" 범위 키. null 이면 항상 허용 불가. */
  key: string | null;
  /** "이 세션 동안 허용" 범위 키. pairingId 와 함께 있어야 쓰인다. */
  sessionKey?: string | null;
  pairingId?: string;
}

export class ConfirmationGate {
  /** `${pairingId}\n${sessionKey}` → 만료 시각. 설정 파일에는 쓰지 않는다. */
  private readonly sessionGrants = new Map<string, number>();
  private pending = 0;
  private inputTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ConfigStore,
    private readonly confirmer: Confirmer,
    private readonly timeoutMs: number = CONFIRM_TIMEOUT_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** key 가 null 이면 "항상 허용" 불가: 기록을 보지 않고, 'always' 답도 이번만 허용으로 처리한다. */
  async check(req: GateRequest): Promise<boolean> {
    const key = req.key;
    if (key !== null && this.store.get().alwaysAllow.some((r) => r.key === key)) return true;
    const sessionId = req.sessionKey && req.pairingId ? `${req.pairingId}\n${req.sessionKey}` : null;
    if (sessionId !== null && this.hasSessionGrant(sessionId)) return true;

    let decision: ConfirmDecision;
    this.pending += 1;
    try {
      // 마우스·키보드 동작이 진행 중이면 끝난 뒤에 확인을 띄운다 — 입력이 확인 창을 누르지 못하게.
      await this.inputTail;
      decision = await this.ask(req, key, sessionId !== null);
    } finally {
      this.pending -= 1;
    }

    if (decision === 'session') {
      // 세션 허용을 제안하지 않은 요청이면 이번만 허용.
      if (sessionId !== null) this.sessionGrants.set(sessionId, this.now() + SESSION_GRANT_TTL_MS);
      return true;
    }
    if (decision === 'always') {
      if (key === null) return true;
      await this.store.update((c) => {
        if (!c.alwaysAllow.some((r) => r.key === key)) {
          c.alwaysAllow.push({ key, createdAt: new Date().toISOString() });
        }
      });
      return true;
    }
    return decision === 'allow';
  }

  /**
   * 입력 도구 실행을 감싼다. 확인 대기 중이면 InputBlockedError, 실행 중에는 새 확인 표시를 미룬다.
   * 입력 동작끼리는 순서대로 실행한다.
   */
  async withInputLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending > 0) throw new InputBlockedError();
    const previous = this.inputTail;
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { release = resolve; });
    this.inputTail = previous.then(() => done);
    try {
      await previous;
      if (this.pending > 0) throw new InputBlockedError();
      return await fn();
    } finally {
      release();
    }
  }

  sessionGrantCount(): number {
    const t = this.now();
    for (const [id, expiresAt] of this.sessionGrants) {
      if (expiresAt <= t) this.sessionGrants.delete(id);
    }
    return this.sessionGrants.size;
  }

  clearSessionGrants(): number {
    const count = this.sessionGrantCount();
    this.sessionGrants.clear();
    return count;
  }

  private hasSessionGrant(id: string): boolean {
    const expiresAt = this.sessionGrants.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt > this.now()) return true;
    this.sessionGrants.delete(id);
    return false;
  }

  private async ask(req: GateRequest, key: string | null, sessionAllowed: boolean): Promise<ConfirmDecision> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConfirmDecision>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('deny');
      }, this.timeoutMs);
    });
    try {
      const {
        key: _key, sessionKey: _sessionKey, pairingId: _pairingId,
        alwaysAllowed: _alwaysAllowed, grantKey: _grantKey, sessionAllowed: _sessionAllowed, ...rest
      } = req;
      const request: ConfirmRequest = key !== null
        ? { ...rest, alwaysAllowed: true, grantKey: key, sessionAllowed }
        : { ...rest, alwaysAllowed: false, sessionAllowed };
      return await Promise.race([this.confirmer.confirm(request, controller.signal), timeout]);
    } catch {
      return 'deny';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
