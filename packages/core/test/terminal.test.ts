import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PROMPT_INPUT_GRACE_MS, randomConfirmCode, sanitizeForTerminal, truncateSummaryForDisplay, TerminalIO } from '../src/terminal.js';

/** 코드는 47 로 고정(codes 를 주면 차례로), 시계는 answer() 가 유예 시간 뒤로 넘긴다. */
function io(codes: number[] = [47]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (c: Buffer) => { printed += c.toString('utf8'); });
  let clock = 1_000_000;
  let i = 0;
  const term = new TerminalIO(input, output, { now: () => clock, code: () => codes[Math.min(i++, codes.length - 1)] });
  const answer = (line: string) => {
    clock += PROMPT_INPUT_GRACE_MS + 1;
    input.write(`${line}\n`);
  };
  const advance = (ms: number) => { clock += ms; };
  return { input, term, printed: () => printed, answer, advance };
}

const req = (summary: string, alwaysAllowed = true) => ({
  tool: 'shell_exec', summary, origin: 'https://studio.aeyes.dev', accountLabel: 'ky***',
  alwaysAllowed, grantKey: alwaysAllowed ? `shell_exec:${summary.split(' ')[0]}` : undefined,
});
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('TerminalIO', () => {
  it('코드 / 코드a / 그 외 입력을 allow / always / deny 로', async () => {
    const { answer, term } = io();
    const p1 = term.confirm(req('ls'), new AbortController().signal);
    await tick(); answer('47');
    expect(await p1).toBe('allow');
    const p2 = term.confirm(req('ls'), new AbortController().signal);
    await tick(); answer('47A');
    expect(await p2).toBe('always');
    const p3 = term.confirm(req('ls'), new AbortController().signal);
    await tick(); answer('');
    expect(await p3).toBe('deny');
    term.close();
  });

  it('맨 y·a·s, 틀린 코드, 코드 뒤 다른 글자는 모두 거부', async () => {
    for (const line of ['y', 'a', 's', 'yes', '48', '4', '470', '47x', '47 a', ' 47y']) {
      const { answer, term } = io();
      const p = term.confirm({ ...req('ls'), sessionAllowed: true }, new AbortController().signal);
      await tick(); answer(line);
      expect(await p, line).toBe('deny');
      term.close();
    }
  });

  it('프롬프트에 코드를 보여 주고, 항상 허용 가능하면 범위와 함께 [코드a] 를 보여 준다', async () => {
    const { answer, term, printed } = io();
    const p = term.confirm(req('git status'), new AbortController().signal);
    await tick();
    expect(printed()).toContain('[47] 이번만 허용');
    expect(printed()).toContain('[47a] 항상 허용 (범위: shell_exec:git)');
    answer('47a');
    expect(await p).toBe('always');
    term.close();
  });

  it('항상 허용 불가면 [코드a] 를 보이지 않고 코드a 입력은 거부', async () => {
    const { answer, term, printed } = io();
    const p = term.confirm(req('git status; rm -rf ~', false), new AbortController().signal);
    await tick();
    expect(printed()).not.toContain('47a]');
    answer('47a');
    expect(await p).toBe('deny');
    term.close();
  });

  it('alwaysAllowed 가 없는 요청도 항상 허용을 받지 않는다', async () => {
    const { answer, term, printed } = io();
    const p = term.confirm({ tool: 'fs_delete', summary: 'x', origin: 'o', accountLabel: '' }, new AbortController().signal);
    await tick();
    expect(printed()).not.toContain('47a]');
    answer('47a');
    expect(await p).toBe('deny');
    term.close();
  });

  it('프롬프트마다 새 코드를 쓴다: 이전 코드는 다음 확인에서 거부', async () => {
    const { answer, term, printed } = io([47, 83]);
    const first = term.confirm(req('ls'), new AbortController().signal);
    await tick(); answer('47');
    expect(await first).toBe('allow');
    const second = term.confirm(req('ls'), new AbortController().signal);
    await tick();
    expect(printed()).toContain('[83] 이번만 허용');
    answer('47');
    expect(await second).toBe('deny');
    term.close();
  });

  it('프롬프트가 뜨기 전·직후 유예 시간 안에 도착한 줄은 답으로 보지 않는다', async () => {
    const { input, term, printed, advance } = io();
    const p = term.confirm(req('ls'), new AbortController().signal);
    // 미리 쳐 둔(버퍼에 있던) 입력이 프롬프트 직후 도착 — 코드가 맞아도 무시.
    input.write('47\n');
    input.write('47\n');
    await tick();
    expect(printed()).toContain('확인이 뜨기 전에 들어온 입력은 무시했습니다');
    expect(printed().split('무시했습니다').length - 1).toBe(1);
    advance(PROMPT_INPUT_GRACE_MS - 1);
    input.write('47\n');
    await tick();
    let settled = false;
    void p.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    advance(2);
    input.write('47\n');
    expect(await p).toBe('allow');
    term.close();
  });

  it('TTY 입력이면 프롬프트를 띄울 때 대기 중인 입력을 비운다(비운 줄은 답이 아니다)', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const clock = 5_000;
    const term = new TerminalIO(input, output, { now: () => clock, code: () => 47 });
    input.pause();
    input.write('47\n');
    const read = vi.spyOn(input, 'read');
    const p = term.confirm(req('ls'), new AbortController().signal);
    expect(read).toHaveBeenCalled();
    await tick();
    let settled = false;
    void p.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    term.close();
    expect(await p).toBe('deny');
  });

  it('randomConfirmCode 는 10~99', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = randomConfirmCode();
      expect(Number.isInteger(code)).toBe(true);
      expect(code).toBeGreaterThanOrEqual(10);
      expect(code).toBeLessThanOrEqual(99);
    }
  });

  it('대기 중인 확인이 10개를 넘으면 새 확인은 즉시 거부한다', async () => {
    const { answer, term } = io();
    const first = term.confirm(req('ls 0'), new AbortController().signal);
    const queued = Array.from({ length: 10 }, (_, i) => term.confirm(req(`ls ${i + 1}`), new AbortController().signal));
    const overflow = term.confirm(req('ls 11'), new AbortController().signal);
    expect(await overflow).toBe('deny');
    await tick();
    answer('47');
    expect(await first).toBe('allow');
    // 한 자리가 비면 다시 받는다.
    const again = term.confirm(req('ls 12'), new AbortController().signal);
    term.close();
    expect(await Promise.all(queued)).toEqual(Array(10).fill('deny'));
    expect(await again).toBe('deny');
  });

  it('serializes concurrent prompts: 답은 순서대로 각 요청에 적용', async () => {
    const { answer, term, printed } = io();
    const first = term.confirm(req('rm a'), new AbortController().signal);
    const second = term.confirm(req('rm b'), new AbortController().signal);
    await tick();
    expect(printed()).toContain('rm a');
    expect(printed()).not.toContain('rm b');
    answer('n');
    expect(await first).toBe('deny');
    await tick();
    expect(printed()).toContain('rm b');
    answer('47');
    expect(await second).toBe('allow');
    term.close();
  });

  it('abort 되면 deny 로 끝나고 다음 확인으로 넘어간다', async () => {
    const { answer, term } = io();
    const controller = new AbortController();
    const first = term.confirm(req('x'), controller.signal);
    const second = term.confirm(req('y'), new AbortController().signal);
    await tick();
    controller.abort();
    expect(await first).toBe('deny');
    await tick();
    answer('47');
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

  it('세션 허용 가능하면 [코드s] 를 보여 주고 코드s 는 session, 불가하면 [코드s] 가 없고 코드s 는 거부', async () => {
    const { answer, term, printed } = io();
    const p = term.confirm(
      { tool: 'mouse_click', summary: '클릭', origin: 'o', accountLabel: 'a', alwaysAllowed: false, sessionAllowed: true },
      new AbortController().signal
    );
    await tick();
    expect(printed()).toContain('[47s] 이 세션 동안 허용(마우스·키보드, 60분)');
    answer('47s');
    expect(await p).toBe('session');
    const before = printed().length;
    const q = term.confirm({ tool: 'shell_exec', summary: 'ls', origin: 'o', accountLabel: 'a' }, new AbortController().signal);
    await tick();
    expect(printed().slice(before)).not.toContain('47s]');
    answer('47s');
    expect(await q).toBe('deny');
    term.close();
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
    const { answer, term, printed } = io();
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
    answer('n');
    expect(await p).toBe('deny');
    term.close();
  });

  it('긴 명령의 꼬리를 가리지 않는다: 위험한 뒷부분이 잘려 사라지지 않고 그대로 보인다', async () => {
    const { answer, term, printed } = io();
    const command = 'a'.repeat(1990) + '; rm -rf ~'; // 총 2000자
    expect(command).toHaveLength(2000);
    const p = term.confirm({
      tool: 'shell_exec',
      summary: command,
      origin: 'https://studio.aeyes.dev',
      accountLabel: 'me',
    }, new AbortController().signal);
    await tick();
    const shown = printed();
    expect(shown).toContain('rm -rf ~');
    expect(shown).toContain('(총 2000자)');
    answer('n');
    expect(await p).toBe('deny');
    term.close();
  });
});

describe('truncateSummaryForDisplay', () => {
  it('짧은 요약은 그대로 둔다', () => {
    expect(truncateSummaryForDisplay('ls', 500)).toBe('ls');
    expect(truncateSummaryForDisplay('x'.repeat(500), 500)).toBe('x'.repeat(500));
  });

  it('max 를 넘으면 앞 250자 + … + 뒤 250자 + 총 길이를 보여 주고 꼬리를 가리지 않는다', () => {
    const command = 'a'.repeat(1990) + '; rm -rf ~';
    const out = truncateSummaryForDisplay(command, 500);
    expect(out).toContain('rm -rf ~');
    expect(out.startsWith('a'.repeat(250))).toBe(true);
    expect(out.endsWith('(총 2000자)')).toBe(true);
    expect(out).toContain(' … ');
  });
});
