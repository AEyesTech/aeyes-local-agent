/**
 * 마우스·키보드 제어. 모두 PC 확인이 필요하고 "항상 허용"은 없다("이 세션 동안 허용"만, policy/gate.ts).
 * 좌표는 논리 픽셀. 다중 모니터에서 주 모니터 왼쪽·위는 음수일 수 있다.
 */
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { KEY_NAMES, type InputDriver, type MouseButton } from '../native.js';
import { defineTool, jsonResult, type ToolDef } from './types.js';

const coord = z.number().int().min(-32768).max(32767);
const TYPE_MAX = 2000;
const keyName = z.enum(KEY_NAMES as unknown as [string, ...string[]]);

export function createInputTools(driver: InputDriver): ToolDef[] {
  return [
    defineTool({
      name: 'mouse_move',
      description: '마우스 커서를 화면 좌표(x, y, 논리 픽셀)로 옮긴다. PC 에서 확인을 받는다("이 세션 동안 허용" 가능).',
      inputSchema: { x: coord, y: coord },
      readOnly: false,
      confirm: 'always',
      summarize: (a) => `마우스 이동: (${String(a.x)}, ${String(a.y)})`,
      handler: async (args) => {
        await driver.moveMouse(args.x, args.y);
        return jsonResult({ moved: { x: args.x, y: args.y } });
      },
    }),
    defineTool({
      name: 'mouse_click',
      description: '마우스를 클릭한다. x, y 를 주면 그 위치로 옮긴 뒤 클릭한다. button 기본 left, double 이면 더블클릭. PC 에서 확인을 받는다.',
      inputSchema: {
        x: coord.optional(),
        y: coord.optional(),
        button: z.enum(['left', 'right', 'middle']).optional(),
        double: z.boolean().optional(),
      },
      readOnly: false,
      confirm: 'always',
      summarize: (a) => {
        const where = typeof a.x === 'number' && typeof a.y === 'number' ? `(${a.x}, ${a.y})` : '현재 위치';
        return `마우스 ${String(a.button ?? 'left')} ${a.double === true ? '더블클릭' : '클릭'}: ${where}`;
      },
      handler: async (args) => {
        if ((args.x === undefined) !== (args.y === undefined)) {
          throw new ToolError('invalid_argument', 'x 와 y 는 함께 주거나 둘 다 생략해야 합니다');
        }
        if (args.x !== undefined && args.y !== undefined) await driver.moveMouse(args.x, args.y);
        const button: MouseButton = args.button ?? 'left';
        await driver.click(button, args.double === true);
        return jsonResult({ clicked: button, double: args.double === true });
      },
    }),
    defineTool({
      name: 'keyboard_type',
      description: `현재 포커스된 곳에 글자를 입력한다(최대 ${TYPE_MAX}자, 한글 가능). PC 에서 확인을 받는다.`,
      inputSchema: { text: z.string().min(1).max(TYPE_MAX) },
      readOnly: false,
      confirm: 'always',
      summarize: (a) => `키보드 입력: ${String(a.text)}`,
      handler: async (args) => {
        await driver.typeText(args.text);
        return jsonResult({ typed: args.text.length });
      },
    }),
    defineTool({
      name: 'keyboard_press',
      description:
        '키 조합을 누른다(최대 4개, 예: ["meta","c"] 는 복사). 키: a-z, 0-9, f1-f12, enter, escape, tab, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, shift, control, alt, meta(macOS Cmd·Windows Win). PC 에서 확인을 받는다.',
      inputSchema: { keys: z.array(keyName).min(1).max(4) },
      readOnly: false,
      confirm: 'always',
      summarize: (a) => `키 누르기: ${Array.isArray(a.keys) ? a.keys.map(String).join('+') : ''}`,
      handler: async (args) => {
        await driver.pressKeys(args.keys);
        return jsonResult({ pressed: args.keys });
      },
    }),
  ];
}
