import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TerminalIO } from '../src/terminal.js';

function io() {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (c: Buffer) => { printed += c.toString('utf8'); });
  const term = new TerminalIO(input, output);
  return { input, term, printed: () => printed };
}

const req = (summary: string) => ({ tool: 'shell_exec', summary, origin: 'https://studio.aeyes.dev', accountLabel: 'ky***' });
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('TerminalIO', () => {
  it('y / a / 그 외 입력을 allow / always / deny 로', async () => {
    const { input, term } = io();
    const p1 = term.confirm(req('ls'), new AbortController().signal);
    await tick(); input.write('y\n');
    expect(await p1).toBe('allow');
    const p2 = term.confirm(req('ls'), new AbortController().signal);
    await tick(); input.write('a\n');
    expect(await p2).toBe('always');
    const p3 = term.confirm(req('ls'), new AbortController().signal);
    await tick(); input.write('\n');
    expect(await p3).toBe('deny');
    term.close();
  });

  it('serializes concurrent prompts: 답은 순서대로 각 요청에 적용', async () => {
    const { input, term, printed } = io();
    const first = term.confirm(req('rm a'), new AbortController().signal);
    const second = term.confirm(req('rm b'), new AbortController().signal);
    await tick();
    expect(printed()).toContain('rm a');
    expect(printed()).not.toContain('rm b');
    input.write('n\n');
    expect(await first).toBe('deny');
    await tick();
    expect(printed()).toContain('rm b');
    input.write('y\n');
    expect(await second).toBe('allow');
    term.close();
  });

  it('abort 되면 deny 로 끝나고 다음 확인으로 넘어간다', async () => {
    const { input, term } = io();
    const controller = new AbortController();
    const first = term.confirm(req('x'), controller.signal);
    const second = term.confirm(req('y'), new AbortController().signal);
    await tick();
    controller.abort();
    expect(await first).toBe('deny');
    await tick();
    input.write('y\n');
    expect(await second).toBe('allow');
    term.close();
  });

  it('확인 대기가 없으면 명령으로 전달', async () => {
    const { input, term } = io();
    const handler = vi.fn();
    term.onCommand(handler);
    input.write('p\n');
    await tick();
    expect(handler).toHaveBeenCalledWith('p');
    term.close();
  });
});
