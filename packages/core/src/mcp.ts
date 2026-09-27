/**
 * 요청마다 새 McpServer 를 만들고 도구를 등록한다.
 * confirm:'always' 도구는 핸들러 전에 ConfirmationGate 를 거치고, 모든 호출은 감사 로그에 남긴다.
 * 입력 도구(마우스·키보드)는 게이트의 입력 잠금 안에서 실행한다.
 * 모든 도구 결과 글에서 설정된 DB 연결 문자열·비밀번호를 가린다(shell_exec 로 설정 파일을 읽는 경우 등).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AGENT_VERSION } from './version.js';
import { ToolError } from './errors.js';
import type { AuditLog } from './audit.js';
import type { DatabaseRecord } from './config.js';
import { summarizeArgs } from './audit.js';
import { grantKey, InputBlockedError, sessionGrantKey, type ConfirmationGate } from './policy/gate.js';
import { connectionSecrets, redactAll } from './tools/db.js';
import { errorResult, type ToolContext, type ToolDef, type ToolResult } from './tools/types.js';

export interface RequestIdentity {
  origin: string;
  pairingId: string;
  accountLabel: string;
}

export function createMcpServer(
  tools: ToolDef[],
  deps: {
    allowedDirs: string[];
    deniedDirs?: string[];
    gate: ConfirmationGate;
    audit: AuditLog;
    identity: RequestIdentity;
    /** 설정 폴더. 이 폴더를 가리키는 shell_exec 는 "항상 허용"하지 않는다. */
    configDir?: string;
    /** 결과에서 가릴 DB 연결 문자열의 출처(호출마다 최신 설정을 읽는다). */
    databases?: () => DatabaseRecord[];
  }
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
        const sessionKey = sessionGrantKey(tool.name);
        const decide = (summary: string) =>
          deps.gate.decide({
            tool: tool.name,
            summary,
            origin: deps.identity.origin,
            accountLabel: deps.identity.accountLabel,
            key: grantKey(tool.name, args, deps.configDir),
            sessionKey,
            pairingId: deps.identity.pairingId,
          });
        const ask = async (summary: string) => (await decide(summary)).allowed;
        const ctx: ToolContext = { allowedDirs: deps.allowedDirs, deniedDirs: deps.deniedDirs, confirm: ask };
        let result: ToolResult = errorResult('failed', '도구 실행 중 오류가 났습니다');
        let outcome: 'ok' | 'denied' | 'error' = 'error';
        try {
          const gateDecision = tool.confirm === 'always' ? await decide(tool.summarize(args)) : { allowed: true };
          if (!gateDecision.allowed) {
            result = errorResult('denied_locally', gateDecision.reason === 'input_unsettled'
              ? '시간 초과된 마우스·키보드 동작이 아직 끝나지 않아 확인 없이 거부했습니다. 잠시 뒤 다시 시도하세요'
              : '사용자가 PC 에서 거부했습니다');
            outcome = 'denied';
          } else {
            result = sessionKey !== null
              ? await deps.gate.withInputLock(() => tool.run(args, ctx))
              : await tool.run(args, ctx);
            const errorCode = result.isError ? safeErrorCode(result) : null;
            outcome = !result.isError ? 'ok' : errorCode === 'denied_locally' ? 'denied' : 'error';
          }
        } catch (error) {
          if (error instanceof InputBlockedError) {
            result = errorResult('busy', error.message);
            outcome = 'denied';
          } else if (error instanceof ToolError) {
            // 입력 잠금 시간 초과 등 예상된 실패.
            result = errorResult(error.code, error.message);
            outcome = 'error';
          } else {
            // 확인 게이트(설정 저장 등)나 도구에서 예상 밖 예외가 나도 실행된 것으로 보지 않고, 감사 로그는 반드시 남긴다.
            result = errorResult('failed', '도구 실행 중 오류가 났습니다');
            outcome = 'error';
          }
        } finally {
          await deps.audit.write({
            tool: tool.name,
            origin: deps.identity.origin,
            pairingId: deps.identity.pairingId,
            result: outcome,
            ms: Date.now() - started,
            args: summarizeArgs(args),
          }).catch(() => undefined);
        }
        // ToolResult 는 interface 라 SDK CallToolResult 의 인덱스 시그니처와 맞지 않아 객체 리터럴로 넘긴다.
        return { ...redactResult(result, deps.databases?.() ?? []) };
      }
    );
  }
  return server;
}

/**
 * 일반 도구 결과에서 가릴 비밀번호의 최소 길이. 더 짧은 비밀번호(예: 'a', 'pw')를 가리면 결과 글 곳곳이 *** 로 깨지므로
 * 가리지 않는다(연결 문자열 전체는 항상 가린다). DB 오류 메시지는 redactSecrets 로 길이와 상관없이 모두 가린다.
 */
export const MIN_REDACTED_PASSWORD_LENGTH = 4;

/** 결과 글에서 설정된 DB 연결 문자열·비밀번호를 *** 로 가린다. */
export function redactResult(result: ToolResult, databases: DatabaseRecord[]): ToolResult {
  const secrets = databases.flatMap((d) => connectionSecrets(d.connectionString)
    .filter((secret) => secret === d.connectionString || secret.length >= MIN_REDACTED_PASSWORD_LENGTH));
  if (secrets.length === 0) return result;
  return {
    ...result,
    content: result.content.map((c) => (c.type === 'text' ? { ...c, text: redactAll(c.text, secrets) } : c)),
  };
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
