import { z } from 'zod';
import { ToolError } from '../errors.js';

export type ConfirmRule = 'never' | 'always' | 'overwrite';

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolContext {
  allowedDirs: string[];
  /** overwrite 규칙 도구가 덮어쓰기 직전에 부른다. false 면 실행하지 않는다. */
  confirm(summary: string): Promise<boolean>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly: boolean;
  confirm: ConfirmRule;
  /** 로컬 확인 창에 보일 요약. */
  summarize(args: Record<string, unknown>): string;
  /** 인자 검증 → 실행 → 결과. 예상된 실패(ToolError)는 isError 결과로 바꿔 돌려준다. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function errorResult(code: string, message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }] };
}

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  inputSchema: S;
  readOnly: boolean;
  confirm: ConfirmRule;
  summarize(args: Record<string, unknown>): string;
  handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}): ToolDef {
  const schema = z.object(def.inputSchema);
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    readOnly: def.readOnly,
    confirm: def.confirm,
    summarize: def.summarize,
    async run(args, ctx) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return errorResult('invalid_argument', parsed.error.issues.map((i) => i.message).join('; '));
      try {
        return await def.handler(parsed.data, ctx);
      } catch (error) {
        if (error instanceof ToolError) return errorResult(error.code, error.message);
        return errorResult('failed', error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500));
      }
    },
  };
}
