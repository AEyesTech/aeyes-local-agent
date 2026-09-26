/**
 * 요청마다 새 McpServer 를 만들고 도구를 등록한다.
 * confirm:'always' 도구는 핸들러 전에 ConfirmationGate 를 거치고, 모든 호출은 감사 로그에 남긴다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AGENT_VERSION } from './version.js';
import type { AuditLog } from './audit.js';
import { summarizeArgs } from './audit.js';
import { grantKey, type ConfirmationGate } from './policy/gate.js';
import { errorResult, type ToolDef, type ToolResult } from './tools/types.js';

export interface RequestIdentity {
  origin: string;
  pairingId: string;
  accountLabel: string;
}

export function createMcpServer(
  tools: ToolDef[],
  deps: { allowedDirs: string[]; deniedDirs?: string[]; gate: ConfirmationGate; audit: AuditLog; identity: RequestIdentity }
): McpServer {
  const server = new McpServer({ name: 'aeyes-local-agent', version: AGENT_VERSION });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly },
      },
      async (rawArgs: Record<string, unknown>) => {
        const args = rawArgs ?? {};
        const started = Date.now();
        const ask = (summary: string) =>
          deps.gate.check({
            tool: tool.name,
            summary,
            origin: deps.identity.origin,
            accountLabel: deps.identity.accountLabel,
            key: grantKey(tool.name, args),
          });
        let result: ToolResult;
        let outcome: 'ok' | 'denied' | 'error';
        if (tool.confirm === 'always' && !(await ask(tool.summarize(args)))) {
          result = errorResult('denied_locally', '사용자가 PC 에서 거부했습니다');
          outcome = 'denied';
        } else {
          result = await tool.run(args, { allowedDirs: deps.allowedDirs, deniedDirs: deps.deniedDirs, confirm: ask });
          const errorCode = result.isError ? safeErrorCode(result) : null;
          outcome = !result.isError ? 'ok' : errorCode === 'denied_locally' ? 'denied' : 'error';
        }
        await deps.audit.write({
          tool: tool.name,
          origin: deps.identity.origin,
          pairingId: deps.identity.pairingId,
          result: outcome,
          ms: Date.now() - started,
          args: summarizeArgs(args),
        }).catch(() => undefined);
        // ToolResult 는 interface 라 SDK CallToolResult 의 인덱스 시그니처와 맞지 않아 객체 리터럴로 넘긴다.
        return { ...result };
      }
    );
  }
  return server;
}

function safeErrorCode(result: ToolResult): string | null {
  const first = result.content[0];
  if (!first || first.type !== 'text') return null;
  try {
    return (JSON.parse(first.text) as { error?: string }).error ?? null;
  } catch {
    return null;
  }
}
