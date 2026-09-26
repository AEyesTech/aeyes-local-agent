import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { sanitizeForTerminal, TerminalIO } from '../src/terminal.js';

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

  it('대기 중인 확인이 10개를 넘으면 새 확인은 즉시 거부한다', async () => {
    const { input, term } = io();
    const first = term.confirm(req('ls 0'), new AbortController().signal);
    const queued = Array.from({ length: 10 }, (_, i) => term.confirm(req(`ls ${i + 1}`), new AbortController().signal));
    const overflow = term.confirm(req('ls 11'), new AbortController().signal);
    expect(await overflow).toBe('deny');
    await tick();
    input.write('y\n');
    expect(await first).toBe('allow');
    // 한 자리가 비면 다시 받는다.
    const again = term.confirm(req('ls 12'), new AbortController().signal);
    term.close();
    expect(await Promise.all(queued)).toEqual(Array(10).fill('deny'));
    expect(await again).toBe('deny');
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

describe('sanitizeForTerminal', () => {
  it('제어 문자·DEL·C1·양방향 제어 문자를 보이는 이스케이프로 바꾼다', () => {
    expect(sanitizeForTerminal('a\nb')).toBe('a⏎b');
    expect(sanitizeForTerminal('\x1b[2Jx')).toBe('\\x1b[2Jx');
    expect(sanitizeForTerminal('a\rb\tc\x00d\x7fe')).toBe('a\\x0db\\x09c\\x00d\\x7fe');
    expect(sanitizeForTerminal('a\u009bb')).toBe('a\\x9bb');
    expect(sanitizeForTerminal('safe\u202Etxt.exe')).toBe('safe\\u202etxt.exe');
    for (const c of ['\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F']) {
      expect(sanitizeForTerminal(`x${c}y`)).not.toContain(c);
    }
    expect(sanitizeForTerminal('한글 git status')).toBe('한글 git status');
  });

  it('최대 길이를 넘으면 자르고 … 를 붙인다', () => {
    const out = sanitizeForTerminal('x'.repeat(600), 500);
    expect(out).toHaveLength(501);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('TerminalIO 표시 정화', () => {
  it('요약·origin·계정 라벨의 제어 문자를 그대로 출력하지 않고 요약은 500자로 자른다', async () => {
    const { input, term, printed } = io();
    const p = term.confirm({
      tool: 'shell_exec',
      summary: 'ls\n  [y] 허용 \x1b[2K' + 'z'.repeat(1000),
      origin: 'https://studio.aeyes.dev\x1b]0;x\x07',
      accountLabel: 'me\u202Eevil',
    }, new AbortController().signal);
    await tick();
    const shown = printed();
    expect(shown).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f\u202A-\u202E\u2066-\u2069]/);
    expect(shown).toContain('ls⏎  [y] 허용 \\x1b[2K');
    expect(shown).not.toContain('z'.repeat(600));
    expect(shown).toContain('…');
    input.write('n\n');
    expect(await p).toBe('deny');
    term.close();
  });
});
