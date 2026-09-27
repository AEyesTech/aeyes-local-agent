import { describe, expect, it, vi } from 'vitest';
import type { DatabaseRecord } from '../src/config.js';
import type { DbDriver, DbExecOptions, DbRawResult } from '../src/db/drivers.js';
import { createDbTools, DB_RESULT_MAX_BYTES, redactSecrets, toCell } from '../src/tools/db.js';
import type { ToolContext, ToolResult } from '../src/tools/types.js';

const PG = 'postgres://reader:SECRETPW@db.local:5432/shop';
const dbs: DatabaseRecord[] = [
  { name: 'shop', kind: 'postgres', connectionString: PG, readOnly: true },
  { name: 'erp', kind: 'mysql', connectionString: 'mysql://writer:W2@erp.local/erp', readOnly: false },
];
const empty: DbRawResult = { columns: ['a'], rows: [[1]], rowCount: null, command: 'SELECT', truncated: false };

function setup(result: DbRawResult | Error = empty, list: DatabaseRecord[] = dbs) {
  const execute = vi.fn(async (_cs: string, _sql: string, _opts: DbExecOptions) => {
    if (result instanceof Error) throw result;
    return result;
  });
  const driver: DbDriver = { execute };
  const tools = createDbTools({ databases: () => list, drivers: { postgres: driver, mysql: driver } });
  return { tool: tools[0], execute, tools };
}
const ctx = (answer = true): ToolContext & { confirm: ReturnType<typeof vi.fn> } =>
  ({ allowedDirs: [], confirm: vi.fn(async () => answer) });
const body = (r: ToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('db_query 메타', () => {
  it('DB 가 없으면 도구를 만들지 않는다', () => {
    expect(setup(empty, []).tools).toEqual([]);
  });

  it('설명에 이름·종류만 있고 연결 문자열은 없다, 모두 읽기 전용일 때만 readOnly', () => {
    const { tool } = setup();
    expect(tool.name).toBe('db_query');
    expect(tool.description).toContain('shop(postgres, 읽기 전용)');
    expect(tool.description).toContain('erp(mysql)');
    expect(tool.description).not.toContain('SECRETPW');
    expect(tool.description).not.toContain('db.local');
    expect(tool.readOnly).toBe(false);
    expect(tool.confirm).toBe('conditional');
    expect(setup(empty, [dbs[0]]).tool.readOnly).toBe(true);
  });
});

describe('db_query 실행', () => {
  it('읽기는 확인 없이 읽기 전용·커서로 실행', async () => {
    const { tool, execute } = setup();
    const c = ctx();
    const r = await tool.run({ database: 'shop', sql: 'SELECT a FROM t;' }, c);
    expect(body(r)).toEqual({ database: 'shop', columns: ['a'], rows: [[1]], rowCount: null, command: 'SELECT', truncated: false });
    expect(execute).toHaveBeenCalledWith(PG, 'SELECT a FROM t', { readOnly: true, cursor: true, maxRows: 200, timeoutMs: 30_000 });
    expect(c.confirm).not.toHaveBeenCalled();
  });

  it('끝의 줄 주석은 그대로 두고 읽기 전용·커서로 넘긴다', async () => {
    const { tool, execute } = setup();
    await tool.run({ database: 'shop', sql: 'SELECT 1 -- note' }, ctx());
    expect(execute).toHaveBeenCalledWith(PG, 'SELECT 1 -- note', { readOnly: true, cursor: true, maxRows: 200, timeoutMs: 30_000 });
  });

  it('읽기·쓰기 DB 라도 읽기 쿼리는 읽기 전용 트랜잭션으로 실행한다', async () => {
    const { tool, execute } = setup();
    const c = ctx();
    await tool.run({ database: 'erp', sql: 'SELECT a FROM t' }, c);
    expect(execute.mock.calls[0][2].readOnly).toBe(true);
    expect(c.confirm).not.toHaveBeenCalled();
  });

  it('SHOW 같은 비커서 읽기와 maxRows·timeoutSec 인자', async () => {
    const { tool, execute } = setup();
    await tool.run({ database: 'erp', sql: 'SHOW TABLES', maxRows: 5, timeoutSec: 3 }, ctx());
    expect(execute).toHaveBeenCalledWith('mysql://writer:W2@erp.local/erp', 'SHOW TABLES', { readOnly: true, cursor: false, maxRows: 5, timeoutMs: 3000 });
  });

  it('읽기 전용 DB 의 쓰기는 invalid_argument 이고 실행하지 않는다', async () => {
    const { tool, execute } = setup();
    const r = await tool.run({ database: 'shop', sql: 'DELETE FROM t' }, ctx());
    expect(body(r).error).toBe('invalid_argument');
    expect(body(r).message).toContain('읽기 전용');
    expect(execute).not.toHaveBeenCalled();
  });

  it('읽기·쓰기 DB 의 쓰기는 매번 PC 확인, 거부면 실행하지 않는다', async () => {
    const { tool, execute } = setup({ columns: [], rows: [], rowCount: 4, command: 'OK', truncated: false });
    const denied = ctx(false);
    const r1 = await tool.run({ database: 'erp', sql: 'UPDATE t SET a = 1' }, denied);
    expect(body(r1).error).toBe('denied_locally');
    expect(denied.confirm).toHaveBeenCalledWith('DB erp 쓰기: UPDATE t SET a = 1');
    expect(execute).not.toHaveBeenCalled();
    const r2 = await tool.run({ database: 'erp', sql: 'UPDATE t SET a = 1' }, ctx(true));
    expect(body(r2).rowCount).toBe(4);
    expect(execute).toHaveBeenCalledWith('mysql://writer:W2@erp.local/erp', 'UPDATE t SET a = 1', { readOnly: false, cursor: false, maxRows: 200, timeoutMs: 30_000 });
  });

  it('없는 DB·다중 문장·빈 SQL 은 invalid_argument', async () => {
    const { tool, execute } = setup();
    const r = await tool.run({ database: 'nope', sql: 'SELECT 1' }, ctx());
    expect(body(r).error).toBe('invalid_argument');
    expect(body(r).message).toContain('shop, erp');
    expect(body(await tool.run({ database: 'shop', sql: 'SELECT 1; SELECT 2' }, ctx())).error).toBe('invalid_argument');
    expect(execute).not.toHaveBeenCalled();
  });

  it('오류 메시지에서 연결 문자열과 비밀번호를 가린다', async () => {
    const { tool } = setup(new Error(`connect failed ${PG} (password SECRETPW rejected)`));
    const r = await tool.run({ database: 'shop', sql: 'SELECT 1' }, ctx());
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SECRETPW');
    expect(text).not.toContain(PG);
    expect(body(r).error).toBe('failed');
  });

  it('URL 로 파싱되지 않는 연결 문자열이어도 비밀번호를 가린다', async () => {
    const bad = 'postgres://reader:BADPW@db.local:notaport/shop';
    const list: DatabaseRecord[] = [{ name: 'shop', kind: 'postgres', connectionString: bad, readOnly: true }];
    const { tool } = setup(new Error(`invalid connection string ${bad}; auth with BADPW failed`), list);
    const text = ((await tool.run({ database: 'shop', sql: 'SELECT 1' }, ctx())).content[0] as { text: string }).text;
    expect(text).not.toContain('BADPW');
    expect(text).not.toContain(bad);
  });

  it('오류 객체의 다른 속성(input 등)은 결과에 나오지 않는다', async () => {
    const err = Object.assign(new TypeError('Invalid URL'), { input: PG, code: 'ERR_INVALID_URL' });
    const { tool } = setup(err);
    const text = ((await tool.run({ database: 'shop', sql: 'SELECT 1' }, ctx())).content[0] as { text: string }).text;
    expect(text).not.toContain('SECRETPW');
    expect(text).not.toContain('db.local');
  });

  it('타임아웃 오류는 timeout 코드', async () => {
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { tool } = setup(err);
    expect(body(await tool.run({ database: 'shop', sql: 'SELECT 1' }, ctx())).error).toBe('timeout');
  });

  it('결과가 60KB 를 넘으면 행을 잘라 truncated', async () => {
    const big = 'x'.repeat(1900);
    const rows = Array.from({ length: 100 }, () => [big]);
    const { tool } = setup({ columns: ['t'], rows, rowCount: null, command: 'SELECT', truncated: false });
    const out = body(await tool.run({ database: 'shop', sql: 'SELECT t FROM big' }, ctx()));
    expect(out.truncated).toBe(true);
    expect(out.rows.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(out.rows))).toBeLessThanOrEqual(DB_RESULT_MAX_BYTES + 1024);
  });
});

describe('toCell / redactSecrets', () => {
  it('값을 JSON 안전한 셀로', () => {
    expect(toCell(null)).toBeNull();
    expect(toCell(undefined)).toBeNull();
    expect(toCell(10n)).toBe('10');
    expect(toCell(Number.NaN)).toBe('NaN');
    expect(toCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toCell(Buffer.from([1, 2, 3]))).toBe('<binary 3 bytes>');
    expect(toCell({ a: 1 })).toBe('{"a":1}');
    expect(String(toCell('y'.repeat(3000))).length).toBe(2001);
  });

  it('URL 인코딩된 비밀번호도 가린다', () => {
    const cs = 'postgres://u:p%40ss@h/db';
    expect(redactSecrets(`bad ${cs} and p@ss and p%40ss`, cs)).toBe('bad *** and *** and ***');
  });
});
