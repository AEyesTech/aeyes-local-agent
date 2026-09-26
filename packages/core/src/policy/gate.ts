/**
 * 위험 동작 확인: "항상 허용" 기록이 있으면 통과, 없으면 Confirmer 에 묻는다(120초 무응답은 거부).
 */
import type { ConfigStore } from '../config.js';
import type { ConfirmDecision, Confirmer, ConfirmRequest } from './confirmer.js';

export const CONFIRM_TIMEOUT_MS = 120_000;

export function alwaysAllowKey(tool: string, args: Record<string, unknown>): string {
  if (tool === 'shell_exec') {
    const head = String(args.command ?? '').trim().split(/\s+/)[0] ?? '';
    return `shell_exec:${head.toLowerCase()}`;
  }
  if (tool === 'open_app') return `open_app:${String(args.name ?? '').trim().toLowerCase()}`;
  return tool;
}

export class ConfirmationGate {
  constructor(
    private readonly store: ConfigStore,
    private readonly confirmer: Confirmer,
    private readonly timeoutMs: number = CONFIRM_TIMEOUT_MS
  ) {}

  async check(req: ConfirmRequest & { key: string }): Promise<boolean> {
    if (this.store.get().alwaysAllow.some((r) => r.key === req.key)) return true;
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
      const { key: _key, ...request } = req;
      decision = await Promise.race([this.confirmer.confirm(request, controller.signal), timeout]);
    } catch {
      decision = 'deny';
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (decision === 'always') {
      await this.store.update((c) => {
        if (!c.alwaysAllow.some((r) => r.key === req.key)) {
          c.alwaysAllow.push({ key: req.key, createdAt: new Date().toISOString() });
        }
      });
      return true;
    }
    return decision === 'allow';
  }
}
