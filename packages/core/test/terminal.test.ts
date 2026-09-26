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

const req = (summary: string, alwaysAllowed = true) => ({
  tool: 'shell_exec', summary, origin: 'https://studio.aeyes.dev', accountLabel: 'ky***',
  alwaysAllowed, grantKey: alwaysAllowed ? `shell_exec:${summary.split(' ')[0]}` : undefined,
});
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

  it('항상 허용 가능하면 범위와 함께 [a] 를 보여 준다', async () => {
    const { input, term, printed } = io();
    const p = term.confirm(req('git status'), new AbortController().signal);
    await tick();
    expect(printed()).toContain('[a] 항상 허용 (범위: shell_exec:git)');
    input.write('a\n');
    expect(await p).toBe('always');
    term.close();
  });

  it('항상 허용 불가면 [a] 를 보이지 않고 a 입력은 이번만 허용', async () => {
    const { input, term, printed } = io();
    const p = term.confirm(req('git status; rm -rf ~', false), new AbortController().signal);
    await tick();
    expect(printed()).not.toContain('[a]');
    input.write('a\n');
    expect(await p).toBe('allow');
    term.close();
  });

  it('alwaysAllowed 가 없는 요청도 항상 허용을 받지 않는다', async () => {
    const { input, term, printed } = io();
    const p = term.confirm({ tool: 'fs_delete', summary: 'x', origin: 'o', accountLabel: '' }, new AbortController().signal);
    await tick();
    expect(printed()).not.toContain('[a]');
    input.write('a\n');
    expect(await p).toBe('allow');
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

  it('stdin 이 종료(EOF)되면 대기 중인 확인은 즉시 deny 되고, 이후 확인도 즉시 deny 된다', async () => {
    const { input, term, printed } = io();
    const pending = term.confirm(req('ls'), new AbortController().signal);
    await tick();
    input.end();
    expect(await pending).toBe('deny');
    const after = await term.confirm(req('ls2'), new AbortController().signal);
    expect(after).toBe('deny');
    expect(printed()).toContain('터미널 입력이 닫혀');
  });

  it('stdin 종료 경고는 한 번만 출력된다', async () => {
    const { input, term, printed } = io();
    const p1 = term.confirm(req('a'), new AbortController().signal);
    const p2 = term.confirm(req('b'), new AbortController().signal);
    await tick();
    input.end();
    expect(await p1).toBe('deny');
    expect(await p2).toBe('deny');
    const occurrences = printed().split('터미널 입력이 닫혀').length - 1;
    expect(occurrences).toBe(1);
  });

  it('close() 로 종료할 때는 stdin 종료 경고를 출력하지 않는다', async () => {
    const { term, printed } = io();
    term.close();
    await tick();
    expect(printed()).not.toContain('터미널 입력이 닫혀');
  });
});
