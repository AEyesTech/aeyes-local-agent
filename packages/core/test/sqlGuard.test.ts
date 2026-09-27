import { describe, expect, it } from 'vitest';
import { classifySql, type SqlDialect } from '../src/db/sqlGuard.js';

function kind(sql: string, dialect: SqlDialect = 'postgres') {
  const r = classifySql(sql, dialect);
  return r.ok ? r.kind : `reject:${r.reason}`;
}

describe('classifySql 읽기', () => {
  it.each([
    ['SELECT * FROM orders', 'postgres'],
    ['  select 1;  ', 'postgres'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'postgres'],
    ['VALUES (1), (2)', 'postgres'],
    ['TABLE orders', 'postgres'],
    ['SHOW TABLES', 'mysql'],
    ['EXPLAIN SELECT 1', 'postgres'],
    ['DESCRIBE orders', 'mysql'],
    ["SELECT 'insert; delete' AS s", 'postgres'],
    ['SELECT "update" FROM t', 'postgres'],
    ['SELECT `delete` FROM t', 'mysql'],
    ['SELECT $$ drop table x; $$', 'postgres'],
    ['SELECT $tag$ delete ; $tag$', 'postgres'],
    ['SELECT 1 -- delete from t\n', 'postgres'],
    ['/* drop table x */ SELECT 1', 'postgres'],
    ['SELECT 1 /* a /* b */ delete */', 'postgres'],
    ['SELECT 1 # delete\n', 'mysql'],
    ["SELECT E'a\\' ; DROP TABLE t; --'", 'postgres'],
    ['SELECT replace(name, \'a\', \'b\') FROM t', 'postgres'],
  ] as Array<[string, SqlDialect]>)('%s (%s)', (sql, dialect) => {
    expect(kind(sql, dialect)).toBe('read');
  });

  it('statement 는 끝 세미콜론을 떼고 keyword 는 첫 단어', () => {
    expect(classifySql('  SELECT 1 ;  ', 'postgres')).toEqual({ ok: true, kind: 'read', keyword: 'select', statement: 'SELECT 1' });
  });
});

describe('classifySql 쓰기', () => {
  it.each([
    ['INSERT INTO t VALUES (1)', 'postgres'],
    ['update t set a = 1', 'mysql'],
    ['DELETE FROM t', 'postgres'],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres'],
    ['SELECT * INTO new_t FROM t', 'postgres'],
    ['EXPLAIN ANALYZE SELECT 1', 'postgres'],
    ['EXPLAIN (ANALYZE) DELETE FROM t', 'postgres'],
    ["SELECT nextval('s')", 'postgres'],
    ['SELECT pg_terminate_backend(123)', 'postgres'],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'mysql'],
    ["SELECT load_file('/etc/passwd')", 'mysql'],
    ['CREATE TABLE x (a int)', 'postgres'],
    ['TRUNCATE t', 'postgres'],
    ['CALL p()', 'mysql'],
    ['SELECT 1 FROM t FOR UPDATE', 'postgres'],
    ["SELECT 1--1 INTO OUTFILE '/tmp/x'", 'mysql'],
    ['SELECT 1 /* a /* b */ DELETE FROM t */', 'mysql'],
    ["SELECT 'a\\' INTO OUTFILE '/tmp/x' -- '", 'mysql'],
    ['SET search_path = x', 'postgres'],
  ] as Array<[string, SqlDialect]>)('%s (%s)', (sql, dialect) => {
    expect(kind(sql, dialect)).toBe('write');
  });
});

describe('classifySql 거부', () => {
  it.each([
    ['SELECT 1; DROP TABLE t', 'postgres', '한 번에 한 문장'],
    ['SELECT 1;;', 'postgres', '한 번에 한 문장'],
    ["SELECT 'a\\' ; DROP TABLE t; --'", 'postgres', '한 번에 한 문장'],
    ["SELECT 'abc", 'postgres', '닫히지 않았습니다'],
    ['SELECT 1 /* x', 'postgres', '닫히지 않았습니다'],
    ['SELECT $a$ x', 'postgres', '닫히지 않았습니다'],
    ['/*!50000 DROP TABLE t */ SELECT 1', 'mysql', '실행 주석'],
    ['/*+ MAX_EXECUTION_TIME(1) */ SELECT 1', 'mysql', '실행 주석'],
    ['', 'postgres', '비어 있습니다'],
    ['  ;  ', 'postgres', '비어 있습니다'],
    ['-- 주석만', 'postgres', '비어 있습니다'],
    // MariaDB 실행 주석(추가).
    ["SELECT 1 /*M! INTO OUTFILE '/tmp/x' */", 'mysql', '실행 주석'],
    ["SELECT 1 /*m!100100 INTO OUTFILE '/tmp/x' */", 'mysql', '실행 주석'],
  ] as Array<[string, SqlDialect, string]>)('%s (%s)', (sql, dialect, reason) => {
    const r = classifySql(sql, dialect);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });
});

describe('classifySql 우회 시도(추가)', () => {
  it.each([
    // PostgreSQL 의 -- 주석은 \r 에서도 끝난다. \n 까지 숨기면 INTO 가 가려진다.
    ['SELECT 1 -- x\rINTO new_t FROM t', 'postgres'],
    ["SELECT 1 # x\rINTO OUTFILE '/tmp/x'", 'mysql'],
    // MySQL 의 -- 는 ASCII 공백·제어 문자가 뒤따를 때만 주석이다(NBSP 는 아님).
    ["SELECT 1 --  INTO OUTFILE '/tmp/x'\n", 'mysql'],
    // 비ASCII 식별자 뒤의 $$ / e'…' 는 달러 인용·E 문자열이 아니다.
    ['SELECT é$$ INTO new_t FROM t', 'postgres'],
    ["SELECT ée'a\\' INTO new_t FROM t --'", 'postgres'],
    // 인용 식별자로 부른 부작용 함수.
    ["SELECT \"nextval\"('s')", 'postgres'],
    ['SELECT pg_catalog."pg_terminate_backend"(1)', 'postgres'],
    ['SELECT "PG_SLEEP"(1)', 'postgres'],
    ["SELECT `load_file`('/etc/passwd')", 'mysql'],
    // 문자열 SQL 을 실행하는 함수·추가 부작용 함수.
    ["SELECT query_to_xml('select pg_terminate_backend(1)', true, true, '')", 'postgres'],
    ["SELECT * FROM ts_stat('select 1')", 'postgres'],
    ['SELECT pg_try_advisory_lock(1)', 'postgres'],
    ['SELECT pg_advisory_lock_shared(1)', 'postgres'],
    ["SELECT dblink_send_query('c', 'delete from t')", 'postgres'],
    // 행 잠금.
    ['SELECT * FROM t FOR SHARE', 'postgres'],
    ['SELECT * FROM t FOR KEY SHARE', 'postgres'],
  ] as Array<[string, SqlDialect]>)('%s (%s)', (sql, dialect) => {
    expect(kind(sql, dialect)).toBe('write');
  });

  it('유니코드 이스케이프 식별자 U&"…" 는 거부', () => {
    expect(kind('SELECT U&"pg\\0074erminate_backend"(1)')).toMatch(/^reject:.*유니코드/);
    expect(kind('SELECT u&"x" FROM t')).toMatch(/^reject:/);
  });

  it.each([
    ['SELECT share FROM t', 'postgres'],
    ['SELECT "share", "for" FROM t', 'postgres'],
    ["SELECT U&'d\\0061ta' AS s", 'postgres'],
    ["SELECT 1 --x\nFROM t", 'postgres'],
    ['SELECT a$b FROM t', 'postgres'],
    ["SELECT 'it''s' AS s", 'mysql'],
    ['SELECT lo_price FROM t', 'postgres'],
  ] as Array<[string, SqlDialect]>)('오탐하지 않는 읽기: %s (%s)', (sql, dialect) => {
    expect(kind(sql, dialect)).toBe('read');
  });
});

describe('classifySql 부작용 함수·접두사 보강(리뷰 1차)', () => {
  const both = [
    "SELECT lo_creat(-1)",
    'SELECT lo_open(1, 131072)',
    'SELECT * FROM pg_ls_waldir()',
    'SELECT pg_current_logfile()',
    "SELECT pg_backup_start('x')",
    "SELECT pg_start_backup('x')",
    'SELECT pg_wal_replay_pause()',
    'SELECT pg_log_backend_memory_contexts(1)',
    "SELECT pg_import_system_collations('pg_catalog')",
    "SELECT pg_replication_origin_create('o')",
    "SELECT * FROM pg_logical_slot_get_changes('s', NULL, NULL)",
    "SELECT pg_copy_logical_replication_slot('a','b')",
    "SELECT brin_summarize_new_values('i')",
    "SELECT gin_clean_pending_list('i')",
    'SELECT pg_stat_statements_reset()',
    "SELECT pg_clear_relation_stats('t')",
    'SELECT txid_current()',
    'SELECT pg_current_xact_id()',
    'SELECT setseed(0.5)',
    "SELECT pg_prewarm('t')",
    "SELECT MASTER_POS_WAIT('f',1)",
    "SELECT WAIT_FOR_EXECUTED_GTID_SET('x',10)",
    "SELECT group_replication_set_as_primary('u')",
    "SELECT keyring_key_remove('k')",
    "SELECT version_tokens_set('a=1')",
    'SELECT audit_log_rotate()',
    "SELECT service_get_write_locks('n','l',1)",
    'SELECT mysql_firewall_flush_status()',
    'SELECT LAST_INSERT_ID(5)',
  ];
  it.each(both.flatMap((sql) => [[sql, 'postgres'], [sql, 'mysql']]) as Array<[string, SqlDialect]>)(
    '%s (%s)',
    (sql, dialect) => {
      expect(kind(sql, dialect)).toBe('write');
    }
  );

  it.each([
    ['SELECT NEXT VALUE FOR s', 'mysql'],
    ['SELECT next value for s', 'postgres'],
    ['SELECT @a := 1', 'mysql'],
    ['SELECT @a:=a FROM t', 'mysql'],
  ] as Array<[string, SqlDialect]>)('%s (%s)', (sql, dialect) => {
    expect(kind(sql, dialect)).toBe('write');
  });

  it.each([
    ['SELECT PREVIOUS VALUE FOR s', 'mysql'],
    ['SELECT @a = 1', 'mysql'],
    ["SELECT ':=' AS s", 'mysql'],
    ['SELECT next_value FROM t', 'postgres'],
  ] as Array<[string, SqlDialect]>)('읽기 유지: %s (%s)', (sql, dialect) => {
    expect(kind(sql, dialect)).toBe('read');
  });
});
