/**
 * 데스크톱 확인기: 확인을 줄 세워 한 번에 한 창씩 띄운다. 창을 여는 일은 주입받는다(Electron 셸이 구현).
 * 게이트의 120초 타임아웃(abort)이 오면 창을 닫고 거부한다. 줄이 가득 차면(요청 폭주) 즉시 거부한다.
 */
import { MAX_QUEUED_CONFIRMATIONS, type ConfirmDecision, type Confirmer, type ConfirmRequest } from 'aeyes-local-agent';
import { buildConfirmView, decisionFor, type ConfirmView } from './confirmView.js';

export interface ConfirmWindowHandle {
  /** 누른 버튼 id. 사용자가 창을 닫으면 null. */
  result: Promise<string | null>;
  close(): void;
}

export type OpenConfirmWindow = (view: ConfirmView) => ConfirmWindowHandle;

interface Job {
  view: ConfirmView;
  signal: AbortSignal;
  resolve(decision: ConfirmDecision): void;
  onAbort(): void;
  handle?: ConfirmWindowHandle;
  done: boolean;
}

export class DesktopConfirmer implements Confirmer {
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private seq = 0;
  private closed = false;

  constructor(
    private readonly open: OpenConfirmWindow,
    private readonly opts: { maxQueued?: number; timeoutSec?: number } = {}
  ) {}

  confirm(req: ConfirmRequest, signal: AbortSignal): Promise<ConfirmDecision> {
    if (this.closed || signal.aborted) return Promise.resolve('deny');
    if (this.queue.length >= (this.opts.maxQueued ?? MAX_QUEUED_CONFIRMATIONS)) return Promise.resolve('deny');
    return new Promise<ConfirmDecision>((resolve) => {
      this.seq += 1;
      const job: Job = {
        view: buildConfirmView(`c${this.seq}`, req, this.opts.timeoutSec),
        signal,
        resolve,
        onAbort: () => this.finish(job, 'deny'),
        done: false,
      };
      signal.addEventListener('abort', job.onAbort, { once: true });
      this.queue.push(job);
      this.showNext();
    });
  }

  pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /** 앱 종료 시: 떠 있는 창과 대기 중인 확인을 모두 거부하고 이후 확인도 거부한다. */
  closeAll(): void {
    this.closed = true;
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) this.finish(job, 'deny');
  }

  private showNext(): void {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    let handle: ConfirmWindowHandle;
    try {
      handle = this.open(job.view);
    } catch {
      this.finish(job, 'deny');
      return;
    }
    job.handle = handle;
    handle.result.then(
      (button) => this.finish(job, button === null ? 'deny' : decisionFor(job.view, button)),
      () => this.finish(job, 'deny')
    );
  }

  private finish(job: Job, decision: ConfirmDecision): void {
    if (job.done) return;
    job.done = true;
    job.signal.removeEventListener('abort', job.onAbort);
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.active === job) {
      this.active = null;
      job.handle?.close();
    }
    job.resolve(decision);
    this.showNext();
  }
}
