/**
 * 터미널 입출력: 로컬 확인 프롬프트와 대화형 명령(p/u/q)을 한 입력 스트림으로 처리한다.
 * 확인은 큐로 한 번에 하나씩 보여 주고, 대기 중인 확인이 있으면 입력 줄은 그 답이 된다.
 */
import { createInterface, type Interface } from 'node:readline';
import type { ConfirmDecision, Confirmer, ConfirmRequest } from './policy/confirmer.js';

interface Pending {
  req: ConfirmRequest;
  signal: AbortSignal;
  resolve(decision: ConfirmDecision): void;
  onAbort?: () => void;
}

export class TerminalIO implements Confirmer {
  private readonly rl: Interface;
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private commandHandler: ((line: string) => void) | null = null;

  constructor(input: NodeJS.ReadableStream, private readonly output: NodeJS.WritableStream) {
    this.rl = createInterface({ input, terminal: false });
    this.rl.on('line', (line) => this.onLine(line.trim()));
  }

  onCommand(handler: (line: string) => void): void {
    this.commandHandler = handler;
  }

  confirm(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmDecision> {
    if (signal.aborted) return Promise.resolve('deny');
    return new Promise((resolve) => {
      const pending: Pending = { req, signal, resolve };
      pending.onAbort = () => this.finish(pending, 'deny', '\n(시간 초과로 거부했습니다)\n');
      signal.addEventListener('abort', pending.onAbort, { once: true });
      this.queue.push(pending);
      this.showNext();
    });
  }

  close(): void {
    for (const pending of [...this.queue, ...(this.active ? [this.active] : [])]) pending.resolve('deny');
    this.queue.length = 0;
    this.active = null;
    this.rl.close();
  }

  private showNext(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    const { req } = next;
    this.output.write(
      `\n[확인 필요] ${req.accountLabel || 'AeyeStudio'} (${req.origin})\n` +
      `  ${req.tool}: ${req.summary}\n` +
      '  [y] 허용  [a] 항상 허용  [N] 거부 > '
    );
  }

  private onLine(line: string): void {
    if (this.active) {
      const answer = line.toLowerCase();
      const decision: ConfirmDecision = answer === 'y' ? 'allow' : answer === 'a' ? 'always' : 'deny';
      this.finish(this.active, decision, decision === 'deny' ? '거부했습니다.\n' : '허용했습니다.\n');
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
