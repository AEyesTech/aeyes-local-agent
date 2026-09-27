/**
 * 실제 DB 연결 검사. CI 의 db-integration 잡(서비스 컨테이너)에서만 돈다.
 * 로컬: AEYES_TEST_PG_URL=postgres://… AEYES_TEST_MYSQL_URL=mysql://… pnpm --filter aeyes-local-agent exec vitest run test/dbIntegration.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createMysqlDriver, createPostgresDriver } from '../src/db/drivers.js';

const PG = process.env.AEYES_TEST_PG_URL ?? '';
const MY = process.env.AEYES_TEST_MYSQL_URL ?? '';
const read = { readOnly: true, cursor: true, maxRows: 10, timeoutMs: 5000 };
const write = { readOnly: false, cursor: false, maxRows: 10, timeoutMs: 5000 };

describe.skipIf(!PG)('postgres 실제 연결', () => {
  const d = createPostgresDriver();

  it('커서로 행 수를 자르고, 읽기 전용 트랜잭션에서는 쓰기가 실패한다', async () => {
    const r = await d.execute(PG, 'SELECT g FROM generate_series(1, 50) AS g', read);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    await d.execute(PG, 'CREATE TABLE IF NOT EXISTS aeyes_probe (a int)', write);
    await expect(d.execute(PG, 'INSERT INTO aeyes_probe VALUES (1)', { ...read, cursor: false })).rejects.toThrow(/read-only/);
    const w = await d.execute(PG, 'INSERT INTO aeyes_probe VALUES (1), (2)', write);
    expect(w.rowCount).toBe(2);
  });

  it('statement_timeout 을 넘으면 오류', async () => {
    await expect(d.execute(PG, 'SELECT pg_sleep(3)', { ...read, timeoutMs: 500 })).rejects.toThrow();
  });
});

describe.skipIf(!MY)('mysql 실제 연결', () => {
  const d = createMysqlDriver();

  it('상한에서 자르고, 읽기 전용 트랜잭션에서는 쓰기가 실패한다', async () => {
    const r = await d.execute(MY, 'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 50) SELECT n FROM s', read);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    await d.execute(MY, 'CREATE TABLE IF NOT EXISTS aeyes_probe (a int)', write);
    await expect(d.execute(MY, 'INSERT INTO aeyes_probe VALUES (1)', { ...read, cursor: false })).rejects.toThrow(/READ ONLY/i);
    const w = await d.execute(MY, 'INSERT INTO aeyes_probe VALUES (1), (2)', write);
    expect(w.rowCount).toBe(2);
  });

  it('클라이언트 타임아웃을 넘으면 오류', async () => {
    // SLEEP() 만 있는 쿼리는 서버 max_execution_time 에 끊겨도 오류 없이 1 을 돌려준다(MySQL 문서).
    // 클라이언트·서버 타임아웃 중 누가 먼저여도 오류가 나도록 SLEEP 을 더 큰 쿼리의 일부로 둔다.
    await expect(d.execute(MY, 'SELECT 1 FROM (SELECT 1 AS a) AS t WHERE SLEEP(3) = 0', { ...read, timeoutMs: 500 })).rejects.toThrow();
  });
});
