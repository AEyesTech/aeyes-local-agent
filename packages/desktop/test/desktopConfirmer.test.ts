import { describe, expect, it } from 'vitest';
import type { ConfirmView } from '../src/confirmView.js';
import { DesktopConfirmer, type OpenConfirmWindow } from '../src/desktopConfirmer.js';

const req = { tool: 'shell_exec', summary: 'ls', origin: 'https://studio.aeyes.dev', accountLabel: 'a' };
const tick = () => new Promise((r) => setTimeout(r, 0));

function windows() {
  const opened: Array<{ view: ConfirmView; answer(button: string | null): void; closed: boolean }> = [];
  const open: OpenConfirmWindow = (view) => {
    let answer: (b: string | null) => void = () => undefined;
    const result = new Promise<string | null>((r) => { answer = r; });
    const entry = { view, answer, closed: false };
    opened.push(entry);
    return { result, close: () => { entry.closed = true; } };
  };
  return { open, opened };
}

describe('DesktopConfirmer', () => {
  it('한 번에 한 창씩, 답하면 다음 창을 연다', async () => {
    const w = windows();
    const c = new DesktopConfirmer(w.open);
    const p1 = c.confirm(req, new AbortController().signal);
    const p2 = c.confirm({ ...req, summary: 'pwd' }, new AbortController().signal);
    await tick();
    expect(w.opened).toHaveLength(1);
    expect(c.pendingCount()).toBe(2);
    w.opened[0].answer('allow');
    expect(await p1).toBe('allow');
    await tick();
    expect(w.opened).toHaveLength(2);
    expect(w.opened[1].view.summary).toBe('pwd');
    w.opened[1].answer(null);
    expect(await p2).toBe('deny');
    expect(c.pendingCount()).toBe(0);
  });

  it('제시하지 않은 버튼은 거부, 제시한 always 는 always', async () => {
    const w = windows();
    const c = new DesktopConfirmer(w.open);
    const p1 = c.confirm(req, new AbortController().signal);
    await tick();
    w.opened[0].answer('session');
    expect(await p1).toBe('deny');
    const p2 = c.confirm({ ...req, alwaysAllowed: true, grantKey: 'shell_exec:ls' }, new AbortController().signal);
    await tick();
    w.opened[1].answer('always');
    expect(await p2).toBe('always');
  });

  it('시간 초과(abort)면 창을 닫고 거부, 다음 창으로 넘어간다', async () => {
    const w = windows();
    const c = new DesktopConfirmer(w.open);
    const ac = new AbortController();
    const p1 = c.confirm(req, ac.signal);
    const p2 = c.confirm(req, new AbortController().signal);
    await tick();
    ac.abort();
    expect(await p1).toBe('deny');
    expect(w.opened[0].closed).toBe(true);
    await tick();
    expect(w.opened).toHaveLength(2);
    w.opened[1].answer('allow');
    expect(await p2).toBe('allow');
  });

  it('대기 줄이 가득 차면 새 확인은 즉시 거부', async () => {
    const w = windows();
    const c = new DesktopConfirmer(w.open, { maxQueued: 1 });
    void c.confirm(req, new AbortController().signal);
    void c.confirm(req, new AbortController().signal);
    await tick();
    expect(await c.confirm(req, new AbortController().signal)).toBe('deny');
  });

  it('창을 열다 실패하면 거부하고 다음으로', async () => {
    let first = true;
    const w = windows();
    const c = new DesktopConfirmer((view) => {
      if (first) { first = false; throw new Error('no display'); }
      return w.open(view);
    });
    const p1 = c.confirm(req, new AbortController().signal);
    const p2 = c.confirm(req, new AbortController().signal);
    expect(await p1).toBe('deny');
    await tick();
    w.opened[0].answer('allow');
    expect(await p2).toBe('allow');
  });

  it('closeAll 은 모두 거부하고 이후 확인도 거부', async () => {
    const w = windows();
    const c = new DesktopConfirmer(w.open);
    const p1 = c.confirm(req, new AbortController().signal);
    const p2 = c.confirm(req, new AbortController().signal);
    await tick();
    c.closeAll();
    expect(await p1).toBe('deny');
    expect(await p2).toBe('deny');
    expect(w.opened[0].closed).toBe(true);
    expect(await c.confirm(req, new AbortController().signal)).toBe('deny');
    expect(w.opened).toHaveLength(1);
  });
});
