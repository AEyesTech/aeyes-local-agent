import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createMysqlDriver, createPostgresDriver, type MysqlModuleLike, type PgModuleLike } from '../src/db/drivers.js';

type PgQuery = { text: string; rowMode?: string; queryMode?: string };
type PgResult = { command: string | null; rowCount: number | null; fields?: Array<{ name: string }>; rows?: unknown[] };

function fakePg(respond: (text: string) => PgResult | Error) {
  const clients: Array<{ config: Record<string, unknown>; queries: PgQuery[]; ended: boolean }> = [];
  const module = {
    Client: function (config: Record<string, unknown>) {
      const state = { config, queries: [] as PgQuery[], ended: false };
      clients.push(state);
      return {
        connect: async () => undefined,
        query: async (q: PgQuery) => {
          state.queries.push(q);
          const r = respond(q.text);
          if (r instanceof Error) throw r;
          return r;
        },
        end: async () => { state.ended = true; },
        on: () => undefined,
      };
    },
  } as unknown as PgModuleLike;
  return { module, clients };
}

const ok: PgResult = { command: 'BEGIN', rowCount: null };
const opts = { maxRows: 2, timeoutMs: 5000 };

describe('postgres 드라이버', () => {
  it('읽기: 읽기 전용 트랜잭션 + 커서 FETCH(max+1) + ROLLBACK, 행 수를 자른다', async () => {
    const { module, clients } = fakePg((text) => text.startsWith('FETCH')
      ? { command: 'FETCH', rowCount: 3, fields: [{ name: 'a' }], rows: [[1], [2], [3]] }
      : ok);
    const r = await createPostgresDriver(async () => module).execute('postgres://h/db', 'SELECT a FROM t', { ...opts, readOnly: true, cursor: true });
    expect(r).toEqual({ columns: ['a'], rows: [[1], [2]], rowCount: null, command: 'SELECT', truncated: true });
    const c = clients[0];
    expect(c.queries.map((q) => q.text)).toEqual([
      'BEGIN TRANSACTION READ ONLY',
      'DECLARE aeyes_cursor NO SCROLL CURSOR FOR SELECT a FROM t',
      'FETCH FORWARD 3 FROM aeyes_cursor',
      'ROLLBACK',
    ]);
    expect(c.queries[1].queryMode).toBe('extended');
    expect(c.queries[2].rowMode).toBe('array');
    expect(c.config).toMatchObject({ connectionString: 'postgres://h/db', statement_timeout: 5000, connectionTimeoutMillis: 10_000 });
    expect(c.ended).toBe(true);
  });

  it('끝에 줄 주석이 있어도 커서 래퍼 뒤에 아무것도 붙이지 않는다(FETCH 는 별도 문장)', async () => {
    const { module, clients } = fakePg((text) => text.startsWith('FETCH')
      ? { command: 'FETCH', rowCount: 1, fields: [{ name: '?column?' }], rows: [[1]] }
      : ok);
    const r = await createPostgresDriver(async () => module).execute('postgres://h/db', 'SELECT 1 -- note', { ...opts, readOnly: true, cursor: true });
    expect(r.rows).toEqual([[1]]);
    const texts = clients[0].queries.map((q) => q.text);
    expect(texts).toEqual([
      'BEGIN TRANSACTION READ ONLY',
      'DECLARE aeyes_cursor NO SCROLL CURSOR FOR SELECT 1 -- note',
      'FETCH FORWARD 3 FROM aeyes_cursor',
      'ROLLBACK',
    ]);
    // 래퍼 문장은 사용자 SQL 로 끝나야 한다 — 뒤에 붙는 접미사가 주석에 먹히지 않게.
    expect(texts[1].endsWith('SELECT 1 -- note')).toBe(true);
  });

  it('쓰기: BEGIN + extended 한 문장 + COMMIT, 영향 행 수', async () => {
    const { module, clients } = fakePg((text) => text.startsWith('INSERT') ? { command: 'INSERT', rowCount: 2, fields: [], rows: [] } : ok);
    const r = await createPostgresDriver(async () => module).execute('postgres://h/db', 'INSERT INTO t VALUES (1), (2)', { ...opts, readOnly: false, cursor: false });
    expect(r).toEqual({ columns: [], rows: [], rowCount: 2, command: 'INSERT', truncated: false });
    expect(clients[0].queries.map((q) => q.text)).toEqual(['BEGIN', 'INSERT INTO t VALUES (1), (2)', 'COMMIT']);
    expect(clients[0].queries[1].queryMode).toBe('extended');
  });

  it('연결(connect)이 실패해도 end() 로 닫고, 연결 안 된 클라이언트에 ROLLBACK 을 보내지 않는다', async () => {
    const state = { ended: false, queries: [] as string[] };
    const module = {
      Client: function () {
        return {
          connect: async () => { throw new Error('connect ECONNREFUSED'); },
          query: async (q: PgQuery) => { state.queries.push(q.text); return ok; },
          end: async () => { state.ended = true; },
          on: () => undefined,
        };
      },
    } as unknown as PgModuleLike;
    await expect(createPostgresDriver(async () => module).execute('postgres://h/db', 'SELECT 1', { ...opts, readOnly: true, cursor: true }))
      .rejects.toThrow('ECONNREFUSED');
    expect(state.ended).toBe(true);
    expect(state.queries).toEqual([]);
  });

  it('오류면 ROLLBACK 을 시도하고 연결을 닫은 뒤 다시 던진다', async () => {
    const { module, clients } = fakePg((text) => text.startsWith('SHOW') ? new Error('boom') : ok);
    await expect(createPostgresDriver(async () => module).execute('postgres://h/db', 'SHOW x', { ...opts, readOnly: true, cursor: false })).rejects.toThrow('boom');
    expect(clients[0].queries.map((q) => q.text)).toEqual(['BEGIN TRANSACTION READ ONLY', 'SHOW x', 'ROLLBACK']);
    expect(clients[0].ended).toBe(true);
  });
});

type Script = Array<[string, ...unknown[]]>;

function fakeMysql(script: (sql: string) => Script, effective: { multipleStatements: boolean; clientFlags: number } = { multipleStatements: false, clientFlags: 0 }) {
  const state = { statements: [] as string[], destroyed: false, streamDestroyed: false, config: {} as Record<string, unknown> };
  const module = {
    createConnection: (config: Record<string, unknown>) => {
      state.config = config;
      return {
        // mysql2 의 실제 연결 설정(URI 쿼리 매개변수가 합쳐진 값).
        config: effective,
        stream: { destroy: () => { state.streamDestroyed = true; } },
        query: (options: { sql: string }) => {
          state.statements.push(options.sql);
          const emitter = new EventEmitter();
          setImmediate(() => {
            for (const [event, ...args] of script(options.sql)) {
              if (state.destroyed) break;
              emitter.emit(event, ...args);
            }
          });
          return emitter;
        },
        end: (cb?: () => void) => { cb?.(); },
        destroy: () => { state.destroyed = true; },
        on: () => undefined,
      };
    },
  } as unknown as MysqlModuleLike;
  return { module, state };
}

describe('mysql 드라이버', () => {
  it('읽기: START TRANSACTION READ ONLY, 상한 초과 시 연결을 끊고 자른 결과', async () => {
    const { module, state } = fakeMysql((sql) => sql.startsWith('SELECT')
      ? [['fields', [{ name: 'a' }]], ['result', [1]], ['result', [2]], ['result', [3]], ['end']]
      : [['end']]);
    const r = await createMysqlDriver(async () => module).execute('mysql://h/db', 'SELECT a FROM t', { ...opts, readOnly: true, cursor: true });
    expect(r).toEqual({ columns: ['a'], rows: [[1], [2]], rowCount: null, command: 'SELECT', truncated: true });
    expect(state.statements).toEqual(['SET SESSION max_execution_time = 5000', 'START TRANSACTION READ ONLY', 'SELECT a FROM t']);
    expect(state.destroyed).toBe(true);
    // 상한에서 끊을 때 소켓까지 닫아 서버가 더 보내지 않게 한다.
    expect(state.streamDestroyed).toBe(true);
    expect(state.config).toMatchObject({ uri: 'mysql://h/db', multipleStatements: false, connectTimeout: 10_000 });
  });

  it('URI 가 다중 문(multipleStatements·MULTI_STATEMENTS 플래그)을 켜면 문장을 보내지 않고 거부한다', async () => {
    for (const effective of [{ multipleStatements: true, clientFlags: 0 }, { multipleStatements: false, clientFlags: 0x00010000 }]) {
      const { module, state } = fakeMysql(() => [['end']], effective);
      const p = createMysqlDriver(async () => module).execute('mysql://u:PW@h/db?multipleStatements=true', 'SELECT 1', { ...opts, readOnly: true, cursor: true });
      await expect(p).rejects.toMatchObject({ code: 'invalid_argument' });
      await expect(p).rejects.toThrow(/다중 문/);
      await p.catch((e: Error) => expect(e.message).not.toContain('PW'));
      expect(state.statements).toEqual([]);
      expect(state.destroyed).toBe(true);
    }
  });

  it('설정을 확인할 수 없는 연결도 거부한다', async () => {
    const module = {
      createConnection: () => ({ query: () => new EventEmitter(), destroy: () => undefined, on: () => undefined }),
    } as unknown as MysqlModuleLike;
    await expect(createMysqlDriver(async () => module).execute('mysql://h/db', 'SELECT 1', { ...opts, readOnly: true, cursor: true }))
      .rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('쓰기: START TRANSACTION + COMMIT, affectedRows', async () => {
    const { module, state } = fakeMysql((sql) => sql.startsWith('UPDATE')
      ? [['result', { affectedRows: 3 }], ['end']]
      : [['end']]);
    const r = await createMysqlDriver(async () => module).execute('mysql://h/db', 'UPDATE t SET a = 1', { ...opts, readOnly: false, cursor: false });
    expect(r).toEqual({ columns: [], rows: [], rowCount: 3, command: 'OK', truncated: false });
    expect(state.statements).toEqual(['SET SESSION max_execution_time = 5000', 'START TRANSACTION', 'UPDATE t SET a = 1', 'COMMIT']);
  });

  it('연결 자체가 실패하면(쿼리 이벤트 없이 연결 error 만 올 때) 멈추지 않고 그 오류로 실패한다', async () => {
    const statements: string[] = [];
    const conn = new EventEmitter();
    const module = {
      createConnection: () => {
        setImmediate(() => conn.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { fatal: true })));
        return {
          config: { multipleStatements: false, clientFlags: 0 },
          // mysql2 는 콜백 없는 쿼리의 연결 오류를 쿼리가 아니라 연결 error 이벤트로만 알린다.
          query: (options: { sql: string }) => {
            statements.push(options.sql);
            return new EventEmitter();
          },
          destroy: () => undefined,
          on: (event: string, listener: (...args: unknown[]) => void) => conn.on(event, listener),
        };
      },
    } as unknown as MysqlModuleLike;
    await expect(createMysqlDriver(async () => module).execute('mysql://h/db', 'SELECT 1', { ...opts, readOnly: true, cursor: true }))
      .rejects.toThrow('ECONNREFUSED');
    expect(statements).not.toContain('SELECT 1');
  });

  it('max_execution_time 이 없는 서버(MariaDB)여도 진행하고, 쿼리 오류는 ROLLBACK 후 던진다', async () => {
    const { module, state } = fakeMysql((sql) => sql.startsWith('SET')
      ? [['error', new Error('Unknown system variable')], ['end']]
      : sql.startsWith('SELECT') ? [['error', new Error('bad sql')], ['end']] : [['end']]);
    await expect(createMysqlDriver(async () => module).execute('mysql://h/db', 'SELECT x', { ...opts, readOnly: true, cursor: true })).rejects.toThrow('bad sql');
    expect(state.statements).toEqual(['SET SESSION max_execution_time = 5000', 'START TRANSACTION READ ONLY', 'SELECT x', 'ROLLBACK']);
  });
});
