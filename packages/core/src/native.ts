/**
 * 화면·입력 제어 네이티브 드라이버. 선택 의존성(optionalDependencies)이라 설치·로드에 실패할 수 있고,
 * 그러면 해당 도구를 등록하지 않는다. 모듈 타입은 구조 타입으로만 다룬다(패키지가 없어도 typecheck 통과).
 * 테스트는 importer 를 바꿔 끼워 실제 화면 없이 검사한다.
 */
export interface DisplayInfo {
  id: string | number;
  name: string;
}

export interface ScreenDriver {
  listDisplays(): Promise<DisplayInfo[]>;
  /** PNG 버퍼. */
  capture(displayId: string | number): Promise<Buffer>;
}

export type MouseButton = 'left' | 'right' | 'middle';

export interface InputDriver {
  moveMouse(x: number, y: number): Promise<void>;
  click(button: MouseButton, double: boolean): Promise<void>;
  typeText(text: string): Promise<void>;
  /** KEY_NAMES 의 이름들. 모두 누른 뒤 역순으로 뗀다. */
  pressKeys(keys: string[]): Promise<void>;
}

export interface NativeDrivers {
  screen: ScreenDriver | null;
  input: InputDriver | null;
}

export const NO_NATIVE: NativeDrivers = Object.freeze({ screen: null, input: null });

export type ModuleImporter = (specifier: string) => Promise<unknown>;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
const NAMED_TO_NUT: Record<string, string> = {
  enter: 'Enter', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  shift: 'LeftShift', control: 'LeftControl', alt: 'LeftAlt',
};

/** keyboard_press 가 받는 키 이름. meta 는 macOS Cmd, Windows Win 키. */
export const KEY_NAMES: readonly string[] = Object.freeze([
  ...LETTERS, ...DIGITS, ...FUNCTION_KEYS, ...Object.keys(NAMED_TO_NUT), 'meta',
]);

export function nutKeyName(key: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return `Num${key}`;
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase();
  if (key === 'meta') return platform === 'darwin' ? 'LeftCmd' : 'LeftSuper';
  const named = NAMED_TO_NUT[key];
  if (!named) throw new Error(`지원하지 않는 키: ${key}`);
  return named;
}

interface NutLike {
  mouse: {
    config: { autoDelayMs: number };
    setPosition(point: unknown): Promise<unknown>;
    click(button: number): Promise<unknown>;
    doubleClick(button: number): Promise<unknown>;
  };
  keyboard: {
    config: { autoDelayMs: number };
    type(...input: string[]): Promise<unknown>;
    pressKey(...keys: number[]): Promise<unknown>;
    releaseKey(...keys: number[]): Promise<unknown>;
  };
  Point: new (x: number, y: number) => unknown;
  Button: Record<'LEFT' | 'MIDDLE' | 'RIGHT', number>;
  Key: Record<string, number | string>;
}

function isNut(value: unknown): value is NutLike {
  const v = value as Partial<NutLike> | null;
  return !!v && typeof v.mouse?.setPosition === 'function' && typeof v.keyboard?.type === 'function'
    && typeof v.Point === 'function' && !!v.Button && !!v.Key;
}

/** 모듈 네임스페이스에 원하는 모양이 없으면 CJS default 를 본다. */
function pick<T>(mod: unknown, guard: (v: unknown) => v is T): T | null {
  if (guard(mod)) return mod;
  const inner = (mod as { default?: unknown } | null)?.default;
  return guard(inner) ? inner : null;
}

export function createNutInputDriver(mod: unknown, platform: NodeJS.Platform = process.platform): InputDriver {
  const nut = pick(mod, isNut);
  if (!nut) throw new Error('@nut-tree-fork/nut-js 형식이 아닙니다');
  nut.mouse.config.autoDelayMs = 20;
  nut.keyboard.config.autoDelayMs = 10;
  const buttons: Record<MouseButton, number> = { left: nut.Button.LEFT, middle: nut.Button.MIDDLE, right: nut.Button.RIGHT };
  const keyCode = (name: string): number => {
    const value = nut.Key[nutKeyName(name, platform)];
    if (typeof value !== 'number') throw new Error(`지원하지 않는 키: ${name}`);
    return value;
  };
  return {
    async moveMouse(x, y) {
      await nut.mouse.setPosition(new nut.Point(x, y));
    },
    async click(button, double) {
      if (double) await nut.mouse.doubleClick(buttons[button]);
      else await nut.mouse.click(buttons[button]);
    },
    async typeText(text) {
      await nut.keyboard.type(text);
    },
    async pressKeys(names) {
      const keys = names.map(keyCode);
      try {
        await nut.keyboard.pressKey(...keys);
      } finally {
        // 누르다 실패해도 눌린 채로 남지 않게 뗀다.
        await nut.keyboard.releaseKey(...[...keys].reverse());
      }
    },
  };
}

interface ScreenshotDesktopLike {
  (options: { screen?: string | number; format: 'png' }): Promise<Buffer>;
  listDisplays(): Promise<Array<{ id: string | number; name?: unknown }>>;
}

function isScreenshotDesktop(value: unknown): value is ScreenshotDesktopLike {
  return typeof value === 'function' && typeof (value as { listDisplays?: unknown }).listDisplays === 'function';
}

export function createScreenshotDriver(mod: unknown): ScreenDriver {
  const shot = pick(mod, isScreenshotDesktop);
  if (!shot) throw new Error('screenshot-desktop 형식이 아닙니다');
  return {
    async listDisplays() {
      return (await shot.listDisplays()).map((d, i) => ({
        id: d.id,
        name: typeof d.name === 'string' && d.name ? d.name : `디스플레이 ${i}`,
      }));
    },
    async capture(displayId) {
      return shot({ screen: displayId, format: 'png' });
    },
  };
}

const defaultImporter: ModuleImporter = (specifier) => import(specifier);

/** 선택 의존성을 불러온다. 실패한 쪽은 null(해당 도구 미등록). 예외를 던지지 않는다. */
export async function loadNativeDrivers(
  importer: ModuleImporter = defaultImporter,
  platform: NodeJS.Platform = process.platform
): Promise<NativeDrivers> {
  const [screen, input] = await Promise.all([
    importer('screenshot-desktop').then((m) => createScreenshotDriver(m)).catch(() => null),
    importer('@nut-tree-fork/nut-js').then((m) => createNutInputDriver(m, platform)).catch(() => null),
  ]);
  return { screen, input };
}
