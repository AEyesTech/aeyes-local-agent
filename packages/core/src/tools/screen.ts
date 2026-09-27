/**
 * screenshot: 화면(모니터 지정 가능)을 PNG 로 캡처해 MCP image 콘텐츠로 돌려준다.
 * macOS 는 화면 기록 권한이 없으면 창 없이 배경만 찍힐 수 있다(README 안내).
 */
import { z } from 'zod';
import { ToolError } from '../errors.js';
import type { ScreenDriver } from '../native.js';
import { defineTool, type ToolDef } from './types.js';

export const SCREENSHOT_MAX_BYTES = 15 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function createScreenTools(driver: ScreenDriver, opts: { maxBytes?: number } = {}): ToolDef[] {
  const maxBytes = opts.maxBytes ?? SCREENSHOT_MAX_BYTES;
  return [
    defineTool({
      name: 'screenshot',
      description:
        '화면을 PNG 이미지로 캡처한다. display 는 모니터 번호(0 = 주 모니터, 생략 시 0). 결과 텍스트에 모니터 목록이 있다. PC 에서 확인을 받는다.',
      inputSchema: { display: z.number().int().min(0).max(15).optional().describe('모니터 번호(0부터)') },
      readOnly: true,
      confirm: 'always',
      summarize: (a) => `화면 캡처(모니터 ${typeof a.display === 'number' ? a.display : 0})`,
      handler: async (args) => {
        const displays = await driver.listDisplays();
        if (displays.length === 0) throw new ToolError('failed', '캡처할 화면을 찾지 못했습니다');
        const index = args.display ?? 0;
        const target = displays[index];
        if (!target) throw new ToolError('invalid_argument', `모니터 번호는 0~${displays.length - 1} 사이여야 합니다`);
        const png = await driver.capture(target.id);
        if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new ToolError('failed', '캡처 결과가 PNG 가 아닙니다');
        }
        if (png.length > maxBytes) {
          throw new ToolError('too_large', `캡처 이미지가 너무 큽니다(${png.length} 바이트, 최대 ${maxBytes})`);
        }
        return {
          content: [
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            {
              type: 'text',
              text: JSON.stringify({
                display: index,
                name: target.name,
                bytes: png.length,
                displays: displays.map((d, i) => ({ index: i, name: d.name })),
              }),
            },
          ],
        };
      },
    }),
  ];
}
