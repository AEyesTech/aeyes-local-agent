import { describe, expect, it, vi } from 'vitest';
import { createNutInputDriver, createScreenshotDriver, KEY_NAMES, loadNativeDrivers, nutKeyName } from '../src/native.js';

function fakeNut(pressFails = false) {
  const calls: string[] = [];
  class Point { constructor(readonly x: number, readonly y: number) {} }
  const Key: Record<string, number | string> = { A: 72, C: 90, Num1: 30, F5: 5, Enter: 103, LeftCmd: 107, LeftSuper: 105, LeftShift: 87, LeftControl: 104, LeftAlt: 108 };
  const nut = {
    mouse: {
      config: { autoDelayMs: 100 },
      setPosition: vi.fn(async (p: Point) => { calls.push(`pos ${p.x},${p.y}`); }),
      click: vi.fn(async (b: number) => { calls.push(`click ${b}`); }),
      doubleClick: vi.fn(async (b: number) => { calls.push(`double ${b}`); }),
    },
    keyboard: {
      config: { autoDelayMs: 300 },
      type: vi.fn(async (...t: string[]) => { calls.push(`type ${t.join('')}`); }),
      pressKey: vi.fn(async (...k: number[]) => {
        if (pressFails) throw new Error('boom');
        calls.push(`press ${k.join(',')}`);
      }),
      releaseKey: vi.fn(async (...k: number[]) => { calls.push(`release ${k.join(',')}`); }),
    },
    Point,
    Button: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
    Key,
  };
  return { nut, calls };
}

describe('nutKeyName / KEY_NAMES', () => {
  it('글자·숫자·기능키·이름 키를 nut Key 이름으로', () => {
    expect(nutKeyName('a')).toBe('A');
    expect(nutKeyName('1')).toBe('Num1');
    expect(nutKeyName('f5')).toBe('F5');
    expect(nutKeyName('enter')).toBe('Enter');
    expect(nutKeyName('shift')).toBe('LeftShift');
    expect(nutKeyName('meta', 'darwin')).toBe('LeftCmd');
    expect(nutKeyName('meta', 'win32')).toBe('LeftSuper');
    expect(() => nutKeyName('capslock')).toThrow();
  });
  it('KEY_NAMES 는 허용 키만 담는다', () => {
    expect(KEY_NAMES).toEqual(expect.arrayContaining(['a', 'z', '0', '9', 'f1', 'f12', 'enter', 'meta', 'pagedown']));
    expect(KEY_NAMES).not.toContain('capslock');
  });
});

describe('createNutInputDriver', () => {
  it('이동·클릭·입력·키 조합을 nut 호출로 바꾼다', async () => {
    const { nut, calls } = fakeNut();
    const driver = createNutInputDriver(nut, 'darwin');
    expect(nut.mouse.config.autoDelayMs).toBe(20);
    expect(nut.keyboard.config.autoDelayMs).toBe(10);
    await driver.moveMouse(10, 20);
    await driver.click('right', false);
    await driver.click('left', true);
    await driver.typeText('안녕');
    await driver.pressKeys(['meta', 'c']);
    expect(calls).toEqual(['pos 10,20', 'click 2', 'double 0', 'type 안녕', 'press 107,90', 'release 90,107']);
  });

  it('누르기가 실패해도 키를 뗀다', async () => {
    const { nut, calls } = fakeNut(true);
    const driver = createNutInputDriver(nut, 'win32');
    await expect(driver.pressKeys(['control', 'a'])).rejects.toThrow('boom');
    expect(calls).toEqual(['release 72,104']);
  });

  it('default 로 감싼 CJS 모듈도 받고, 형식이 다르면 오류', () => {
    const { nut } = fakeNut();
    expect(() => createNutInputDriver({ default: nut })).not.toThrow();
    expect(() => createNutInputDriver({ mouse: {} })).toThrow();
  });
});

describe('createScreenshotDriver', () => {
  it('목록 이름이 없으면 번호 이름을 붙이고 png 로 캡처한다', async () => {
    const shot = Object.assign(vi.fn(async () => Buffer.from('png')), {
      listDisplays: vi.fn(async () => [{ id: 0, name: 'Color LCD' }, { id: '\\\\.\\DISPLAY2' }]),
    });
    const driver = createScreenshotDriver({ default: shot });
    expect(await driver.listDisplays()).toEqual([{ id: 0, name: 'Color LCD' }, { id: '\\\\.\\DISPLAY2', name: '디스플레이 1' }]);
    await driver.capture('\\\\.\\DISPLAY2');
    expect(shot).toHaveBeenCalledWith({ screen: '\\\\.\\DISPLAY2', format: 'png' });
  });
});

describe('loadNativeDrivers', () => {
  it('불러오기 실패면 드라이버 없음(null)', async () => {
    const drivers = await loadNativeDrivers(async () => { throw new Error('not installed'); });
    expect(drivers).toEqual({ screen: null, input: null });
  });

  it('형식이 다른 모듈도 null', async () => {
    expect(await loadNativeDrivers(async () => ({}))).toEqual({ screen: null, input: null });
  });

  it('둘 다 있으면 둘 다 만든다', async () => {
    const { nut } = fakeNut();
    const shot = Object.assign(async () => Buffer.from('png'), { listDisplays: async () => [] });
    const drivers = await loadNativeDrivers(async (s) => (s === 'screenshot-desktop' ? shot : nut), 'darwin');
    expect(drivers.screen).not.toBeNull();
    expect(drivers.input).not.toBeNull();
  });
});
