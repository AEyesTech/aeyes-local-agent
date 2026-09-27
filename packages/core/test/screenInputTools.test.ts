import { describe, expect, it, vi } from 'vitest';
import type { InputDriver, ScreenDriver } from '../src/native.js';
import { createInputTools } from '../src/tools/input.js';
import { createScreenTools } from '../src/tools/screen.js';
import type { ToolContext, ToolDef, ToolResult } from '../src/tools/types.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')]);
const ctx: ToolContext = { allowedDirs: [], confirm: async () => true };
const byName = (tools: ToolDef[]) => Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;
const errorCode = (r: ToolResult) => JSON.parse((r.content[0] as { text: string }).text).error as string;

function screen(overrides: Partial<ScreenDriver> = {}): ScreenDriver {
  return {
    listDisplays: async () => [{ id: 0, name: '주 모니터' }, { id: 'DISPLAY2', name: '보조' }],
    capture: vi.fn(async () => PNG),
    ...overrides,
  };
}

function input(): InputDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    moveMouse: async (x, y) => { calls.push(`move ${x},${y}`); },
    click: async (b, d) => { calls.push(`click ${b} ${d}`); },
    typeText: async (t) => { calls.push(`type ${t}`); },
    pressKeys: async (k) => { calls.push(`keys ${k.join('+')}`); },
  };
}

describe('screenshot', () => {
  it('readOnly·항상 확인, PNG image 콘텐츠와 모니터 목록', async () => {
    const driver = screen();
    const { screenshot } = byName(createScreenTools(driver));
    expect(screenshot.readOnly).toBe(true);
    expect(screenshot.confirm).toBe('always');
    const r = await screenshot.run({ display: 1 }, ctx);
    expect(r.isError).toBeFalsy();
    expect(driver.capture).toHaveBeenCalledWith('DISPLAY2');
    expect(r.content[0]).toEqual({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
    expect(JSON.parse((r.content[1] as { text: string }).text)).toEqual({
      display: 1, name: '보조', bytes: PNG.length, displays: [{ index: 0, name: '주 모니터' }, { index: 1, name: '보조' }],
    });
    expect(screenshot.summarize({})).toBe('화면 캡처(모니터 0)');
  });

  it('없는 모니터 번호·PNG 아님·너무 큼은 오류', async () => {
    expect(errorCode(await byName(createScreenTools(screen())).screenshot.run({ display: 5 }, ctx))).toBe('invalid_argument');
    const notPng = screen({ capture: async () => Buffer.from('jpeg') });
    expect(errorCode(await byName(createScreenTools(notPng)).screenshot.run({}, ctx))).toBe('failed');
    expect(errorCode(await byName(createScreenTools(screen(), { maxBytes: 5 })).screenshot.run({}, ctx))).toBe('too_large');
    const none = screen({ listDisplays: async () => [] });
    expect(errorCode(await byName(createScreenTools(none)).screenshot.run({}, ctx))).toBe('failed');
  });
});

describe('입력 도구', () => {
  it('메타: 모두 readOnly false, 항상 확인', () => {
    const tools = createInputTools(input());
    expect(tools.map((t) => t.name).sort()).toEqual(['keyboard_press', 'keyboard_type', 'mouse_click', 'mouse_move']);
    for (const t of tools) {
      expect(t.readOnly, t.name).toBe(false);
      expect(t.confirm, t.name).toBe('always');
    }
  });

  it('이동·클릭·입력·키 조합', async () => {
    const driver = input();
    const t = byName(createInputTools(driver));
    await t.mouse_move.run({ x: 10, y: -20 }, ctx);
    await t.mouse_click.run({ x: 1, y: 2, button: 'right' }, ctx);
    await t.mouse_click.run({ double: true }, ctx);
    await t.keyboard_type.run({ text: '안녕하세요' }, ctx);
    await t.keyboard_press.run({ keys: ['meta', 'v'] }, ctx);
    expect(driver.calls).toEqual([
      'move 10,-20', 'move 1,2', 'click right false', 'click left true', 'type 안녕하세요', 'keys meta+v',
    ]);
  });

  it('x 만 주거나 지원하지 않는 키는 invalid_argument 이고 실행하지 않는다', async () => {
    const driver = input();
    const t = byName(createInputTools(driver));
    expect(errorCode(await t.mouse_click.run({ x: 1 }, ctx))).toBe('invalid_argument');
    expect(errorCode(await t.keyboard_press.run({ keys: ['capslock'] }, ctx))).toBe('invalid_argument');
    expect(errorCode(await t.keyboard_press.run({ keys: [] }, ctx))).toBe('invalid_argument');
    expect(errorCode(await t.keyboard_type.run({ text: 'x'.repeat(2001) }, ctx))).toBe('invalid_argument');
    expect(driver.calls).toEqual([]);
  });

  it('확인 창 요약에 좌표·입력 글·키가 보인다', () => {
    const t = byName(createInputTools(input()));
    expect(t.mouse_move.summarize({ x: 3, y: 4 })).toBe('마우스 이동: (3, 4)');
    expect(t.mouse_click.summarize({ x: 3, y: 4, double: true })).toBe('마우스 left 더블클릭: (3, 4)');
    expect(t.mouse_click.summarize({})).toBe('마우스 left 클릭: 현재 위치');
    expect(t.keyboard_type.summarize({ text: 'rm -rf ~' })).toBe('키보드 입력: rm -rf ~');
    expect(t.keyboard_press.summarize({ keys: ['meta', 'q'] })).toBe('키 누르기: meta+q');
  });
});
