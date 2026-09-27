/**
 * 로컬 DB 드라이버(pg·mysql2). 모듈은 변수 지정자로 동적 import 하고 구조 타입으로만 다룬다.
 * - 읽기: 읽기 전용 트랜잭션 안에서 실행하고 ROLLBACK. pg 는 커서 FETCH(max+1)로, mysql 은 상한 초과 시 연결을 끊어 행을 자른다.
 * - 쓰기: 트랜잭션 안에서 실행하고 COMMIT. 오류면 ROLLBACK.
 * - 한 문장만: pg 는 extended 프로토콜(다중 문장 불가), mysql 은 multipleStatements:false.
 */
import type { DatabaseKind } from '../config.js';
import { ToolError } from '../errors.js';

export interface DbExecOptions {
  readOnly: boolean;
  /** pg 에서 DECLARE CURSOR 로 감쌀지(select/with/values/table 읽기). mysql 은 무시. */
  cursor: boolean;
  maxRows: number;
  timeoutMs: number;
}

export interface DbRawResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number | null;
  command: string | null;
  truncated: boolean;
}

export interface DbDriver {
  execute(connectionString: string, sql: string, opts: DbExecOptions): Promise<DbRawResult>;
}

export type DbDrivers = Record<DatabaseKind, DbDriver>;

export const DB_CONNECT_TIMEOUT_MS = 10_000;
/** MySQL 서버 max_execution_time 을 클라이언트 timeout 보다 이만큼 늦게 건다(클라이언트가 먼저 오류를 내게). */
export const MYSQL_SERVER_TIMEOUT_GRACE_MS = 1_000;

const importModule = (specifier: string): Promise<unknown> => import(specifier);

function unwrap<T>(mod: unknown, key: string, label: string): T {
  const m = mod as (Record<string, unknown> & { default?: Record<string, unknown> }) | null;
  if (m && typeof m[key] === 'function') return m as unknown as T;
  if (m?.default && typeof m.default[key] === 'function') return m.default as unknown as T;
  throw new Error(`${label} 드라이버를 불러올 수 없습니다`);
}

interface PgQueryResult {
  command: string | null;
  rowCount: number | null;
  fields?: Array<{ name: string }>;
  rows?: unknown[];
}

interface PgClientLike {
  connect(): Promise<unknown>;
  query(config: { text: string; rowMode?: 'array'; queryMode?: 'extended' }): Promise<PgQueryResult>;
  end(): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface PgClientConfig {
  connectionString: string;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
  application_name: string;
}

export interface PgModuleLike {
  Client: new (config: PgClientConfig) => PgClientLike;
}

export function createPostgresDriver(
  load: () => Promise<PgModuleLike> = async () => unwrap<PgModuleLike>(await importModule('pg'), 'Client', 'PostgreSQL')
): DbDriver {
  return {
    async execute(connectionString, sql, opts) {
      const pg = await load();
      const client = new pg.Client({
        connectionString,
        connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
        statement_timeout: opts.timeoutMs,
        query_timeout: opts.timeoutMs + 2_000,
        application_name: 'aeyes-local-agent',
      });
      client.on('error', () => undefined);
      let connected = false;
      try {
        await client.connect();
        connected = true;
        await client.query({ text: opts.readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN' });
        let result: PgQueryResult;
        if (opts.cursor) {
          await client.query({ text: `DECLARE aeyes_cursor NO SCROLL CURSOR FOR ${sql}`, queryMode: 'extended' });
          result = await client.query({ text: `FETCH FORWARD ${opts.maxRows + 1} FROM aeyes_cursor`, rowMode: 'array' });
        } else {
          result = await client.query({ text: sql, rowMode: 'array', queryMode: 'extended' });
        }
        await client.query({ text: opts.readOnly ? 'ROLLBACK' : 'COMMIT' });
        const rows = (result.rows ?? []) as unknown[][];
        return {
          columns: (result.fields ?? []).map((f) => f.name),
          rows: rows.slice(0, opts.maxRows),
          rowCount: opts.cursor ? null : result.rowCount,
          command: opts.cursor ? 'SELECT' : result.command,
          truncated: rows.length > opts.maxRows,
        };
      } catch (error) {
        if (connected) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

interface MysqlQueryLike {
  on(event: string, listener: (...args: unknown[]) => void): MysqlQueryLike;
}

interface MysqlConnectionLike {
  query(options: { sql: string; timeout?: number; rowsAsArray?: boolean }): MysqlQueryLike;
  destroy(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** mysql2 가 URI 쿼리 매개변수까지 합친 실제 설정. */
  config?: { multipleStatements?: unknown; clientFlags?: unknown };
  /** 소켓. destroy() 는 반쯤 닫기(end)라 서버가 계속 보낼 수 있어 상한에서는 소켓도 끊는다. */
  stream?: { destroy?: () => void };
}

/** mysql2 CLIENT_MULTI_STATEMENTS 플래그. */
const MYSQL_MULTI_STATEMENTS_FLAG = 0x00010000;

/**
 * mysql2 는 URI 쿼리 매개변수를 거짓 값 옵션 위에 덮어쓴다(multipleStatements: false 가
 * ?multipleStatements=true·?flags=MULTI_STATEMENTS 에 진다). 실제 설정을 확인해 다중 문 연결은 거부한다.
 */
function allowsMultipleStatements(conn: MysqlConnectionLike): boolean {
  const config = conn.config;
  if (!config || typeof config.clientFlags !== 'number') return true;
  return config.multipleStatements !== false || (config.clientFlags & MYSQL_MULTI_STATEMENTS_FLAG) !== 0;
}

export interface MysqlConnectionConfig {
  uri: string;
  connectTimeout: number;
  multipleStatements: false;
  dateStrings: true;
  supportBigNumbers: true;
  bigNumberStrings: true;
}

export interface MysqlModuleLike {
  createConnection(config: MysqlConnectionConfig): MysqlConnectionLike;
}

/**
 * mysql2 는 콜백 없는(이벤트 방식) 쿼리의 연결 오류(ECONNREFUSED·인증 실패·끊김)를 쿼리가 아니라
 * 연결의 'error' 이벤트로만 알린다. 그대로 두면 쿼리 Promise 가 영영 끝나지 않으므로 연결 오류와 경주시킨다.
 */
function watchConnection(conn: MysqlConnectionLike): <T>(promise: Promise<T>) => Promise<T> {
  let failure: Error | null = null;
  const waiters = new Set<(error: Error) => void>();
  conn.on('error', (error) => {
    failure ??= error;
    for (const reject of waiters) reject(error);
    waiters.clear();
  });
  return <T>(promise: Promise<T>): Promise<T> => {
    if (failure) {
      promise.catch(() => undefined);
      return Promise.reject(failure);
    }
    return new Promise<T>((resolve, reject) => {
      const onFailure = (error: Error) => reject(error);
      waiters.add(onFailure);
      promise.then(
        (value) => { waiters.delete(onFailure); resolve(value); },
        (error: unknown) => { waiters.delete(onFailure); reject(error); }
      );
    });
  };
}

function runStatement(conn: MysqlConnectionLike, sql: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    conn.query({ sql, timeout: timeoutMs })
      .on('error', (error) => { if (!settled) { settled = true; reject(error); } })
      .on('end', () => { if (!settled) { settled = true; resolve(); } });
  });
}

export function createMysqlDriver(
  load: () => Promise<MysqlModuleLike> = async () => unwrap<MysqlModuleLike>(await importModule('mysql2'), 'createConnection', 'MySQL')
): DbDriver {
  return {
    async execute(connectionString, sql, opts) {
      const mysql = await load();
      const conn = mysql.createConnection({
        uri: connectionString,
        connectTimeout: DB_CONNECT_TIMEOUT_MS,
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      const guard = watchConnection(conn);
      if (allowsMultipleStatements(conn)) {
        conn.destroy();
        conn.stream?.destroy?.();
        throw new ToolError('invalid_argument', '다중 문(multipleStatements·MULTI_STATEMENTS)을 허용하는 MySQL 연결은 쓸 수 없습니다 — 연결 문자열에서 해당 옵션을 빼세요');
      }
      let destroyed = false;
      try {
        // MySQL 전용 설정(SELECT 에만 적용). MariaDB 등 없는 서버면 무시하고 클라이언트 timeout 에 맡긴다.
        // 서버 제한에 먼저 끊기면 SLEEP 등이 오류 없이 끝나 잘린 결과가 성공처럼 돌아올 수 있다.
        // 클라이언트 timeout 이 항상 먼저 오류를 내도록 서버 제한은 여유를 두고 뒤에 거는 안전망으로만 쓴다.
        await guard(runStatement(conn, `SET SESSION max_execution_time = ${Math.floor(opts.timeoutMs) + MYSQL_SERVER_TIMEOUT_GRACE_MS}`, opts.timeoutMs)).catch(() => undefined);
        await guard(runStatement(conn, opts.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION', opts.timeoutMs));
        const result = await guard(new Promise<DbRawResult>((resolve, reject) => {
          const columns: string[] = [];
          const rows: unknown[][] = [];
          let rowCount: number | null = null;
          let command: string | null = null;
          let truncated = false;
          let settled = false;
          const finish = (value: DbRawResult) => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          };
          conn.query({ sql, timeout: opts.timeoutMs, rowsAsArray: true })
            .on('fields', (fields) => {
              if (Array.isArray(fields) && columns.length === 0) {
                for (const f of fields) columns.push(String((f as { name?: unknown }).name ?? ''));
              }
            })
            .on('result', (row) => {
              if (settled) return;
              if (Array.isArray(row)) {
                command = 'SELECT';
                if (rows.length < opts.maxRows) {
                  rows.push(row);
                  return;
                }
                truncated = true;
                if (opts.readOnly) {
                  // 읽기는 더 받지 않고 연결을 끊는다(읽기 전용 트랜잭션이라 잃을 것이 없다).
                  // 끊을 때 연결 error 가 와도 결과가 이기도록 먼저 끝낸다.
                  destroyed = true;
                  finish({ columns, rows, rowCount: null, command, truncated: true });
                  conn.destroy();
                  conn.stream?.destroy?.();
                }
              } else if (row && typeof row === 'object') {
                const packet = row as { affectedRows?: unknown };
                rowCount = typeof packet.affectedRows === 'number' ? packet.affectedRows : null;
                command = 'OK';
              }
            })
            .on('error', (error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
            })
            .on('end', () => finish({ columns, rows, rowCount, command, truncated }));
        }));
        if (!destroyed) await guard(runStatement(conn, opts.readOnly ? 'ROLLBACK' : 'COMMIT', opts.timeoutMs));
        return result;
      } catch (error) {
        if (!destroyed) await guard(runStatement(conn, 'ROLLBACK', opts.timeoutMs)).catch(() => undefined);
        throw error;
      } finally {
        if (!destroyed) conn.destroy();
      }
    },
  };
}

export function createDefaultDbDrivers(): DbDrivers {
  return { postgres: createPostgresDriver(), mysql: createMysqlDriver() };
}
