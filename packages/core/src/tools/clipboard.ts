import clipboardy from 'clipboardy';
import { z } from 'zod';
import { defineTool, jsonResult, type ToolDef } from './types.js';

export interface ClipboardDeps {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

const CLIPBOARD_MAX = 1024 * 1024;

export function createClipboardTools(
  deps: ClipboardDeps = { read: () => clipboardy.read(), write: (t) => clipboardy.write(t) }
): ToolDef[] {
  return [
    defineTool({
      name: 'clipboard_read',
      description: '클립보드의 텍스트를 읽는다(PC 에서 확인을 받는다).',
      inputSchema: {},
      readOnly: true,
      confirm: 'always',
      summarize: () => '클립보드 읽기',
      handler: async () => jsonResult({ text: (await deps.read()).slice(0, CLIPBOARD_MAX) }),
    }),
    defineTool({
      name: 'clipboard_write',
      description: '클립보드에 텍스트를 넣는다.',
      inputSchema: { text: z.string().max(CLIPBOARD_MAX) },
      readOnly: false,
      confirm: 'never',
      summarize: () => '클립보드 쓰기',
      handler: async (args) => {
        await deps.write(args.text);
        return jsonResult({ written: true, length: args.text.length });
      },
    }),
  ];
}
