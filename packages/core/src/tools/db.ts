/**
 * db_query: 설정 databases 에 등록된 DB 에 SQL 한 문장을 실행한다.
 * 연결 문자열은 설정 파일(0600)에만 있고 도구 설명·결과·오류에 나오지 않는다(오류는 가린다).
 * 읽기 판별은 보수적으로(db/sqlGuard.ts), 읽기는 읽기 전용 트랜잭션, 쓰기는 매번 PC 확인.
 */
import { z } from 'zod';
import type { DatabaseRecord } from '../config.js';
import type { DbDrivers, DbRawResult } from '../db/drivers.js';
import { classifySql, CURSOR_HEADS } from '../db/sqlGuard.js';
import { ToolError } from '../errors.js';
import { sanitizeForTerminal, SUMMARY_DISPLAY_MAX } from '../terminal.js';
import { defineTool, jsonResult, type ToolDef } from './types.js';

export const DB_DEFAULT_ROWS = 200;
export const DB_MAX_ROWS = 1000;
export const DB_DEFAULT_TIMEOUT_SEC = 30;
export const DB_MAX_TIMEOUT_SEC = 120;
export const DB_RESULT_MAX_BYTES = 60 * 1024;
const CELL_TEXT_MAX = 2000;
const COLUMN_NAME_MAX = 200;
const ERROR_MAX = 500;

export interface DbToolDeps {
  databases(): DatabaseRecord[];
  drivers: DbDrivers;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function toCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return cut(value, CELL_TEXT_MAX);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  try {
    return cut(JSON.stringify(value) ?? String(value), CELL_TEXT_MAX);
  } catch {
    return cut(String(value), CELL_TEXT_MAX);
  }
}

/** 오류 메시지에서 연결 문자열 전체와 비밀번호(원문·디코딩)를 *** 로 가린다. */
export function redactSecrets(message: string, connectionString: string): string {
  const secrets = new Set<string>([connectionString]);
  const addPassword = (password: string) => {
    if (!password) return;
    secrets.add(password);
    try {
      secrets.add(decodeURIComponent(password));
    } catch {
      // 잘못된 퍼센트 인코딩이면 원문만 가린다.
    }
  };
  try {
    addPassword(new URL(connectionString).password);
  } catch {
    // URL 형식이 아니면 아래 정규식으로 찾는다.
  }
  // URL 로 파싱되지 않는 문자열(잘못된 포트 등)도 scheme://user:password@host 에서 비밀번호를 찾는다.
  // 마지막 @ 까지 욕심껏 잡는다 — 더 많이 가리는 쪽이 안전하다.
  const loose = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^:@/]*:(.*)@[^@]*$/s.exec(connectionString);
  if (loose) addPassword(loose[1]);
  // 쿼리 매개변수·키=값 형식의 비밀번호(?password=…, &pwd=…, sslpassword=…).
  for (const m of connectionString.matchAll(/(?:^|[?&;\s])(?:password|pwd|passwd|sslpassword)=([^&;\s]*)/gi)) {
    addPassword(m[1]);
    addPassword(m[1].replace(/\+/g, ' '));
  }
  let out = message;
  for (const secret of [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('***');
  }
  return out.slice(0, ERROR_MAX);
}

function isTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === '57014' || code === 'PROTOCOL_SEQUENCE_TIMEOUT' || code === 'ER_QUERY_TIMEOUT' || /time(d)?[ _-]?out/i.test(message);
}

function shapeResult(database: string, raw: DbRawResult, maxRows: number) {
  const rows: unknown[][] = [];
  let truncated = raw.truncated || raw.rows.length > maxRows;
  // 열 이름도 예산에 넣는다. 열이 너무 많으면 예산의 절반까지만 두고, 행도 같은 열 수로 자른다.
  const columns: string[] = [];
  let bytes = 2;
  for (const column of raw.columns) {
    const name = cut(String(column), COLUMN_NAME_MAX);
    const size = Buffer.byteLength(JSON.stringify(name)) + 1;
    if (bytes + size > DB_RESULT_MAX_BYTES / 2) {
      truncated = true;
      break;
    }
    bytes += size;
    columns.push(name);
  }
  const columnLimit = columns.length < raw.columns.length ? columns.length : Infinity;
  for (const row of raw.rows.slice(0, maxRows)) {
    const cells = (columnLimit === Infinity ? row : row.slice(0, columnLimit)).map(toCell);
    const size = Buffer.byteLength(JSON.stringify(cells));
    if (bytes + size > DB_RESULT_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    rows.push(cells);
  }
  return {
    database,
    columns,
    rows,
    rowCount: raw.rowCount,
    command: raw.command,
    truncated,
  };
}

export function createDbTools(deps: DbToolDeps): ToolDef[] {
  const list = deps.databases();
  if (list.length === 0) return [];
  const described = list.map((d) => `${d.name}(${d.kind}${d.readOnly ? ', 읽기 전용' : ''})`).join(', ');
  return [
    defineTool({
      name: 'db_query',
      description:
        `PC 에 설정된 DB 에 SQL 한 문장을 실행한다. database: ${described}. ` +
        `읽기 전용 DB 는 SELECT·WITH·SHOW·EXPLAIN 같은 읽기만 가능하고, 쓰기 쿼리는 PC 에서 확인을 받는다. ` +
        `결과는 최대 ${DB_MAX_ROWS}행(기본 ${DB_DEFAULT_ROWS})·약 60KB, 타임아웃 기본 ${DB_DEFAULT_TIMEOUT_SEC}초.`,
      inputSchema: {
        database: z.string().min(1).max(40).describe('설정된 DB 이름'),
        sql: z.string().min(1).max(20_000),
        maxRows: z.number().int().min(1).max(DB_MAX_ROWS).optional(),
        timeoutSec: z.number().int().min(1).max(DB_MAX_TIMEOUT_SEC).optional(),
      },
      readOnly: list.every((d) => d.readOnly),
      confirm: 'conditional',
      summarize: (a) => `DB ${String(a.database)} 쓰기: ${String(a.sql)}`,
      handler: async (args, ctx) => {
        const current = deps.databases();
        const db = current.find((d) => d.name === args.database);
        if (!db) {
          throw new ToolError('invalid_argument', `설정되지 않은 DB 입니다. 사용 가능: ${current.map((d) => d.name).join(', ')}`);
        }
        const cls = classifySql(args.sql, db.kind);
        if (!cls.ok) throw new ToolError('invalid_argument', cls.reason);
        if (cls.kind === 'write') {
          if (db.readOnly) {
            throw new ToolError('invalid_argument', '읽기 전용 DB 입니다 — SELECT·WITH·SHOW·EXPLAIN 같은 읽기 쿼리만 실행할 수 있습니다');
          }
          const summary = `DB ${db.name} 쓰기: ${cls.statement}`;
          // 확인 화면은 긴 요약의 앞뒤만 보여 준다. 사용자가 쓰기 전체를 보고 허용하도록 화면 길이(이스케이프 후)로 제한한다.
          if (Array.from(sanitizeForTerminal(summary)).length > SUMMARY_DISPLAY_MAX) {
            throw new ToolError('invalid_argument', `쓰기 문은 확인 화면에 전체가 보이도록 ${SUMMARY_DISPLAY_MAX}자 이하로 나눠 보내세요`);
          }
          if (!(await ctx.confirm(summary))) {
            throw new ToolError('denied_locally', '사용자가 PC 에서 거부했습니다');
          }
        }
        const maxRows = args.maxRows ?? DB_DEFAULT_ROWS;
        let raw: DbRawResult;
        try {
          raw = await deps.drivers[db.kind].execute(db.connectionString, cls.statement, {
            readOnly: cls.kind === 'read',
            cursor: cls.kind === 'read' && CURSOR_HEADS.has(cls.keyword),
            maxRows,
            timeoutMs: (args.timeoutSec ?? DB_DEFAULT_TIMEOUT_SEC) * 1000,
          });
        } catch (error) {
          if (error instanceof ToolError) throw new ToolError(error.code, redactSecrets(error.message, db.connectionString));
          const message = error instanceof Error ? error.message : String(error);
          throw new ToolError(isTimeout(error) ? 'timeout' : 'failed', redactSecrets(message, db.connectionString));
        }
        return jsonResult(shapeResult(db.name, raw, maxRows));
      },
    }),
  ];
}
