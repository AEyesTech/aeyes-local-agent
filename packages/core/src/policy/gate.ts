/**
 * 위험 동작 확인: "항상 허용" 기록이 있으면 통과, 없으면 Confirmer 에 묻는다(120초 무응답은 거부).
 * "항상 허용"은 범위를 명확히 좁힐 수 있는 요청(grantKey 가 null 이 아닌 경우)에만 적용된다 —
 * 셸 제어 문자·래퍼 명령·인자가 있는 앱 실행·파일 열기는 매번 묻는다.
 */
import type { ConfigStore } from '../config.js';
import type { ConfirmDecision, Confirmer, ConfirmRequest } from './confirmer.js';

export const CONFIRM_TIMEOUT_MS = 120_000;

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

export class ConfirmationGate {
  constructor(
    private readonly store: ConfigStore,
    private readonly confirmer: Confirmer,
    private readonly timeoutMs: number = CONFIRM_TIMEOUT_MS
  ) {}

  /** key 가 null 이면 "항상 허용" 불가: 기록을 보지 않고, 'always' 답도 이번만 허용으로 처리한다. */
  async check(req: ConfirmRequest & { key: string | null }): Promise<boolean> {
    const key = req.key;
    if (key !== null && this.store.get().alwaysAllow.some((r) => r.key === key)) return true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConfirmDecision>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('deny');
      }, this.timeoutMs);
    });
    let decision: ConfirmDecision;
    try {
      const { key: _key, alwaysAllowed: _a, grantKey: _g, ...rest } = req;
      const request: ConfirmRequest = key !== null
        ? { ...rest, alwaysAllowed: true, grantKey: key }
        : { ...rest, alwaysAllowed: false };
      decision = await Promise.race([this.confirmer.confirm(request, controller.signal), timeout]);
    } catch {
      decision = 'deny';
    } finally {
      if (timer) clearTimeout(timer);
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
}
