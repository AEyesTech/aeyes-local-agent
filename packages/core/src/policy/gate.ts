/**
 * 위험 동작 확인: "항상 허용" 기록이 있으면 통과, 없으면 Confirmer 에 묻는다(120초 무응답은 거부).
 * "항상 허용"은 범위를 명확히 좁힐 수 있는 요청(grantKey 가 null 이 아닌 경우)에만 적용된다 —
 * 셸 제어·글롭 문자·래퍼 명령·인자가 있는 앱 실행·파일 열기·마우스/키보드·DB 쓰기는 매번 묻는다.
 * 마우스·키보드는 "이 세션 동안 허용"(메모리 전용, 페어링별, 60분)만 있다.
 * 입력 도구가 확인 창·터미널 프롬프트를 스스로 누르지 못하도록 확인 대기 중에는 입력을 막고(withInputLock),
 * 입력 동작 중에 온 확인은 입력이 끝나고 INPUT_SETTLE_MS 가 더 지난 뒤에 띄운다(OS 입력 버퍼에 남은 키가 먼저 소진되게).
 * 시간 초과로 버려진 입력 호출이 아직 끝나지 않았으면(최대 INPUT_ABANDON_MAX_MS) 새 확인은 띄우지 않고 즉시 거부하고,
 * 끝나면 INPUT_SETTLE_MS 가 더 지난 뒤에 확인을 띄운다.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConfigStore } from '../config.js';
import { ToolError } from '../errors.js';
import type { ConfirmDecision, Confirmer, ConfirmRequest } from './confirmer.js';

export const CONFIRM_TIMEOUT_MS = 120_000;
/** "이 세션 동안 허용"이 유지되는 최대 시간. 에이전트를 다시 시작하면 그 전에도 사라진다. */
export const SESSION_GRANT_TTL_MS = 60 * 60_000;
/** 입력 동작 하나가 잠금을 쥘 수 있는 최대 시간. 드라이버가 멈춰도 이후 확인·입력이 영영 막히지 않게 한다. */
export const INPUT_LOCK_TIMEOUT_MS = 30_000;
/** 입력 동작이 끝난 뒤 확인을 띄우기 전까지 더 기다리는 시간. 드라이버가 돌아온 뒤에도 OS 에 남은 입력이 확인을 누르지 못하게 한다. */
export const INPUT_SETTLE_MS = 1_000;
/**
 * 시간 초과로 버려진 입력 호출(드라이버가 아직 타이핑 중일 수 있음)을 "끝나지 않음"으로 보는 최대 시간(시간 초과 시점부터).
 * 그동안 새 확인은 즉시 거부한다 — 계속되는 타이핑이 확인에 답하지 못하게.
 */
export const INPUT_ABANDON_MAX_MS = 60_000;
/** 마우스·키보드 입력 도구. "항상 허용"은 없고 "이 세션 동안 허용"만 있다. */
export const INPUT_TOOLS: ReadonlySet<string> = new Set(['mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press']);

/** 셸 제어·치환·리다이렉트·그룹 문자. 하나라도 있으면 첫 단어가 실제 실행 범위를 대표하지 못한다. */
const SHELL_CONTROL = /[;&|`$()<>{}\n\r]/;
/**
 * 셸 글롭 문자(*, ?, [ ]). 글롭은 글자 비교를 우회해 설정 폴더를 가리킬 수 있다(예: cat ~/.aeyes-ag?nt/c*.json).
 * 중괄호 확장({a,b})은 SHELL_CONTROL 에서 이미 막는다.
 */
const SHELL_GLOB = /[*?[\]]/;
/** 셸이 지우는 인용·이스케이프 문자. 'aeyes''-agent', aeyes\-agent 처럼 이름을 쪼개 비교를 우회하지 못하게 지운 형태로도 본다. */
const SHELL_QUOTING = /['"\\]/g;

/**
 * 설정 폴더(페어링 해시·DB 연결 문자열)를 가리킬 수 있는 명령인지. 이런 명령은 "항상 허용"으로 기록하지 않고 매번 묻는다.
 * 실제 경로·~ 상대 경로·폴더 이름, 'aeyes-agent'(대소문자 무시), 'config.json' 을 본다.
 */
export function referencesConfigDir(command: string, configDir?: string, home: string = homedir()): boolean {
  const lower = command.toLowerCase();
  if (lower.includes('aeyes-agent') || lower.includes('config.json')) return true;
  if (!configDir) return false;
  const needles = new Set<string>();
  const add = (value: string) => { if (value) needles.add(value.toLowerCase()); };
  const resolved = path.resolve(configDir);
  add(resolved);
  add(resolved.replace(/\\/g, '/'));
  add(path.basename(resolved));
  const rel = path.relative(home, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    add(`~/${rel.replace(/\\/g, '/')}`);
    add(`~\\${rel.replace(/\//g, '\\')}`);
    add(`$home/${rel.replace(/\\/g, '/')}`);
  }
  return [...needles].some((n) => lower.includes(n));
}

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

export function shellGrantKey(command: string, configDir?: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL.test(trimmed) || SHELL_GLOB.test(trimmed) || trimmed.includes('=')) return null;
  // 설정 폴더를 읽는 명령(예: cat ~/.aeyes-agent/config.json)은 항상 허용된 명령이라도 매번 묻는다.
  // 글자 비교일 뿐이라 재귀 읽기(grep -r … ~)처럼 경로를 적지 않는 명령은 잡지 못한다 — README "보안" 참고.
  if (referencesConfigDir(trimmed, configDir) || referencesConfigDir(trimmed.replace(SHELL_QUOTING, ''), configDir)) return null;
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
export function grantKey(tool: string, args: Record<string, unknown>, configDir?: string): string | null {
  // 입력 제어(세션 허용만)와 DB 쓰기(매번 확인)는 영구 허용하지 않는다.
  if (INPUT_TOOLS.has(tool) || tool === 'db_query') return null;
  if (tool === 'shell_exec') return shellGrantKey(String(args.command ?? ''), configDir);
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

/** 확인 결과. 거부 사유 'input_unsettled' 는 버려진 입력 호출 때문에 확인을 띄우지 않고 거부한 경우. */
export interface GateDecision {
  allowed: boolean;
  reason?: 'input_unsettled';
}

export class ConfirmationGate {
  /** `${pairingId}\n${sessionKey}` → 만료 시각. 설정 파일에는 쓰지 않는다. */
  private readonly sessionGrants = new Map<string, number>();
  private pending = 0;
  /** 입력 동작끼리 줄 세우는 꼬리. */
  private inputTail: Promise<void> = Promise.resolve();
  /** 입력 동작이 끝나고 INPUT_SETTLE_MS 가 지나야 풀리는 꼬리. 확인은 이것을 기다린다. */
  private settledTail: Promise<void> = Promise.resolve();
  /** 시간 초과로 버려졌지만 아직 끝나지 않은 입력 호출 → "끝나지 않음"으로 보는 마감 시각. */
  private readonly abandoned = new Map<symbol, number>();

  constructor(
    private readonly store: ConfigStore,
    private readonly confirmer: Confirmer,
    private readonly timeoutMs: number = CONFIRM_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
    private readonly inputLockTimeoutMs: number = INPUT_LOCK_TIMEOUT_MS,
    private readonly inputSettleMs: number = INPUT_SETTLE_MS
  ) {}

  /** key 가 null 이면 "항상 허용" 불가: 기록을 보지 않고, 'always' 답도 이번만 허용으로 처리한다. */
  async check(req: GateRequest): Promise<boolean> {
    return (await this.decide(req)).allowed;
  }

  /** check 와 같지만 거부 사유를 함께 돌려준다(감사·오류 메시지용). */
  async decide(req: GateRequest): Promise<GateDecision> {
    const key = req.key;
    if (key !== null && this.store.get().alwaysAllow.some((r) => r.key === key)) return { allowed: true };
    const sessionId = req.sessionKey && req.pairingId ? `${req.pairingId}\n${req.sessionKey}` : null;
    if (sessionId !== null && this.hasSessionGrant(sessionId)) return { allowed: true };
    // 버려진 입력 호출이 아직 타이핑 중일 수 있으면 확인을 띄우지 않는다(fail-closed).
    if (this.hasAbandonedInput()) return { allowed: false, reason: 'input_unsettled' };

    let decision: ConfirmDecision;
    this.pending += 1;
    try {
      // 마우스·키보드 동작이 진행 중이면 끝나고 INPUT_SETTLE_MS 가 지난 뒤에 확인을 띄운다 — 입력이 확인 창을 누르지 못하게.
      await this.waitInputSettled();
      if (this.hasAbandonedInput()) return { allowed: false, reason: 'input_unsettled' };
      decision = await this.ask(req, key, sessionId !== null);
    } finally {
      this.pending -= 1;
    }

    if (decision === 'session') {
      // 세션 허용을 제안하지 않은 요청이면 이번만 허용.
      if (sessionId !== null) this.sessionGrants.set(sessionId, this.now() + SESSION_GRANT_TTL_MS);
      return { allowed: true };
    }
    if (decision === 'always') {
      if (key === null) return { allowed: true };
      await this.store.update((c) => {
        if (!c.alwaysAllow.some((r) => r.key === key)) {
          c.alwaysAllow.push({ key, createdAt: new Date().toISOString() });
        }
      });
      return { allowed: true };
    }
    return { allowed: decision === 'allow' };
  }

  /** 시간 초과로 버려진 입력 호출이 아직 끝나지 않았는지(마감 INPUT_ABANDON_MAX_MS 가 지난 것은 끝난 것으로 본다). */
  hasAbandonedInput(): boolean {
    const t = this.now();
    for (const [id, until] of this.abandoned) {
      if (until <= t) this.abandoned.delete(id);
    }
    return this.abandoned.size > 0;
  }

  /** 기다리는 동안 새 입력 동작이 끼어들면 그것까지 기다린다. */
  private async waitInputSettled(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.settledTail;
      await tail;
    } while (tail !== this.settledTail);
  }

  /**
   * 입력 도구 실행을 감싼다. 확인 대기 중이면 InputBlockedError, 실행 중에는 새 확인 표시를 미룬다.
   * 입력 동작끼리는 순서대로 실행한다. fn 이 inputLockTimeoutMs 안에 끝나지 않으면 잠금을 풀고
   * ToolError('timeout') 으로 실패한다(멈춘 드라이버 호출은 결과를 버린다).
   */
  async withInputLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending > 0) throw new InputBlockedError();
    const previous = this.inputTail;
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { release = resolve; });
    this.inputTail = previous.then(() => done);
    const settleMs = this.inputSettleMs;
    const settled = done.then(() => new Promise<void>((resolve) => { setTimeout(resolve, settleMs); }));
    const previousSettled = this.settledTail;
    this.settledTail = Promise.all([previousSettled, previous.then(() => settled)]).then(() => undefined);
    try {
      await previous;
      if (this.pending > 0) throw new InputBlockedError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => { timedOut = true; reject(new ToolError('timeout', `마우스·키보드 동작이 ${Math.round(this.inputLockTimeoutMs / 1000)}초 안에 끝나지 않아 중단했습니다`)); },
          this.inputLockTimeoutMs
        );
      });
      let work: Promise<T> | undefined;
      try {
        work = fn();
        return await Promise.race([work, timeout]);
      } catch (error) {
        if (timedOut && work) {
          // 드라이버 호출은 아직 진행 중일 수 있다. 끝나거나 마감이 지날 때까지 새 확인을 거부한다.
          // 끝난 뒤에도 일반 입력과 같이 INPUT_SETTLE_MS 를 더 기다린 뒤에 확인을 띄운다(OS 에 남은 입력 소진).
          const id = Symbol('abandoned-input');
          this.abandoned.set(id, this.now() + INPUT_ABANDON_MAX_MS);
          const forget = () => {
            const settle = new Promise<void>((resolve) => { setTimeout(resolve, settleMs); });
            this.settledTail = Promise.all([this.settledTail, settle]).then(() => undefined);
            this.abandoned.delete(id);
          };
          work.then(forget, forget);
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
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
