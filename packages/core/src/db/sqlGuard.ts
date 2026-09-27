/**
 * db_query 의 보수적 읽기 판별. 문자열·인용 식별자·주석을 지운 뒤 단어로 판정한다.
 * - 한 문장만 허용(끝의 세미콜론 하나는 뗀다).
 * - 첫 단어가 읽기 머리(select/with/values/table/show/explain/describe/desc)가 아니면 쓰기.
 * - 본문에 쓰기 단어(insert/update/delete/merge/into/analyze/nextval …)나 부작용 함수가 있으면 쓰기.
 * - 서버와 해석이 어긋날 수 있는 부분(백슬래시 이스케이프 설정)은 두 해석으로 모두 검사해 하나라도 쓰기면 쓰기.
 * - MySQL 실행 주석(/*! … *\/)·힌트는 거부. MySQL `--` 는 뒤에 공백이 있을 때만 주석(아니면 빼기 연산자).
 * 판별은 1차 방어선이고, 읽기는 DB 의 읽기 전용 트랜잭션 안에서 실행한다(2차). 읽기 전용 DB 계정 사용을 권장한다.
 */
import type { DatabaseKind } from '../config.js';

export type SqlDialect = DatabaseKind;

export type SqlClassification =
  | { ok: true; kind: 'read' | 'write'; keyword: string; statement: string }
  | { ok: false; reason: string };

const READ_HEADS = new Set(['select', 'with', 'values', 'table', 'show', 'explain', 'describe', 'desc']);
/** PostgreSQL 에서 DECLARE CURSOR 로 감쌀 수 있는 머리(행 수를 서버에서 끊는다). */
export const CURSOR_HEADS: ReadonlySet<string> = new Set(['select', 'with', 'values', 'table']);
const WRITE_WORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke',
  'into', 'outfile', 'dumpfile', 'analyze', 'analyse', 'copy', 'call', 'lock', 'vacuum', 'set',
]);
const SIDE_EFFECT_FUNCTIONS = new Set([
  // 인용 식별자("nextval")로 불러도 잡도록 함수 이름은 여기에 둔다.
  'nextval', 'setval',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_promote',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_file_write',
  'lo_import', 'lo_export', 'lo_unlink', 'lo_create', 'lo_from_bytea', 'lo_put',
  'dblink', 'dblink_exec', 'dblink_connect', 'set_config', 'pg_advisory_lock', 'pg_advisory_xact_lock',
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until', 'pg_notify',
  // 문자열로 받은 SQL 을 실행하는 함수.
  'query_to_xml', 'query_to_xml_and_xmlschema', 'query_to_xmlschema', 'ts_stat',
  'lowrite', 'lo_truncate', 'lo_truncate64', 'pg_file_unlink', 'pg_file_rename', 'pg_switch_wal',
  'pg_create_restore_point', 'pg_logical_emit_message',
  'load_file', 'sleep', 'benchmark', 'get_lock', 'release_lock', 'release_all_locks', 'sys_exec', 'sys_eval',
]);
/** 이 접두어로 시작하는 함수도 부작용으로 본다(dblink_send_query, pg_try_advisory_lock_shared, pg_create_*_replication_slot …). */
const SIDE_EFFECT_PREFIXES = ['dblink', 'pg_advisory', 'pg_try_advisory', 'pg_stat_reset', 'pg_create_', 'pg_drop_'];
const UNTERMINATED = '따옴표나 주석이 닫히지 않았습니다';
/** 식별자를 이루는 문자. 서버(PostgreSQL·MySQL)는 비ASCII 문자도 식별자로 받으므로 함께 본다. */
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
/** MySQL `--` 주석은 뒤에 ASCII 공백·제어 문자가 올 때만. NBSP 같은 유니코드 공백은 주석으로 보지 않는다(숨기는 쪽이 위험). */
const MYSQL_DASH_COMMENT_FOLLOW = /[\x00-\x20]/;

function isSideEffectFunction(word: string): boolean {
  return SIDE_EFFECT_FUNCTIONS.has(word) || SIDE_EFFECT_PREFIXES.some((prefix) => word.startsWith(prefix));
}

/** 줄 주석의 끝(\n 또는 \r 중 먼저). PostgreSQL 은 \r 에서도 주석을 끝낸다 — 더 일찍 끝내는 쪽이 보수적이다. */
function lineEnd(sql: string, from: number): number {
  for (let j = from; j < sql.length; j += 1) {
    if (sql[j] === '\n' || sql[j] === '\r') return j;
  }
  return sql.length;
}

function readQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslash && ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return -1;
}

/** 문자열(→ ` 0 `)·인용 식별자(→ ` _q_ `)·주석(→ 공백)을 지운 SQL. backslashEscapes 는 일반 문자열의 \ 를 이스케이프로 볼지. */
export function scrubSql(
  sql: string,
  dialect: SqlDialect,
  backslashEscapes: boolean
): { ok: true; text: string } | { ok: false; reason: string } {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1] ?? '';
    const prev = i > 0 ? sql[i - 1] : '';
    const lineComment =
      (c === '-' && next === '-' && (dialect === 'postgres' || i + 2 >= sql.length || MYSQL_DASH_COMMENT_FOLLOW.test(sql[i + 2]))) ||
      (c === '#' && dialect === 'mysql');
    if (lineComment) {
      i = lineEnd(sql, i);
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      // MariaDB 는 /*M! … */ 도 실행한다.
      const mariaExec = (sql[i + 2] === 'M' || sql[i + 2] === 'm') && sql[i + 3] === '!';
      if (dialect === 'mysql' && (sql[i + 2] === '!' || sql[i + 2] === '+' || mariaExec)) {
        return { ok: false, reason: 'MySQL 실행 주석(/*! … */, /*M! … */)과 힌트 주석(/*+ … */)은 쓸 수 없습니다' };
      }
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else if (dialect === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) return { ok: false, reason: UNTERMINATED };
      i = j;
      out += ' ';
      continue;
    }
    if (c === "'") {
      // PostgreSQL E'…' 문자열은 설정과 무관하게 백슬래시 이스케이프를 쓴다.
      const eString = dialect === 'postgres' && (prev === 'e' || prev === 'E') && !IDENT_CHAR.test(sql[i - 2] ?? '');
      const end = readQuoted(sql, i, "'", backslashEscapes || eString);
      if (end === -1) return { ok: false, reason: UNTERMINATED };
      i = end;
      out += ' 0 ';
      continue;
    }
    if (c === '"' || (c === '`' && dialect === 'mysql')) {
      // PostgreSQL U&"…" 는 \0074 같은 이스케이프로 이름을 숨길 수 있다(U&"pg\0074erminate_backend"). 드물어서 거부한다.
      if (c === '"' && dialect === 'postgres' && prev === '&' && (sql[i - 2] === 'u' || sql[i - 2] === 'U')) {
        return { ok: false, reason: '유니코드 이스케이프 식별자(U&"…")는 쓸 수 없습니다' };
      }
      const end = readQuoted(sql, i, c, c === '"' && dialect === 'mysql' && backslashEscapes);
      if (end === -1) return { ok: false, reason: UNTERMINATED };
      // 인용 식별자는 키워드가 아니지만 함수 이름일 수는 있다("nextval"('s')). 부작용 함수 이름이면 단어로 남긴다.
      const name = sql.slice(i + 1, end - 1).split(c + c).join(c).toLowerCase();
      out += /^[a-z_][a-z0-9_$]*$/.test(name) && isSideEffectFunction(name) ? ` ${name} ` : ' _q_ ';
      i = end;
      continue;
    }
    if (c === '$' && dialect === 'postgres' && !IDENT_CHAR.test(prev)) {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) return { ok: false, reason: UNTERMINATED };
        i = close + tag.length;
        out += ' 0 ';
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return { ok: true, text: out };
}

export function classifySql(sql: string, dialect: SqlDialect): SqlClassification {
  const statement = String(sql ?? '').trim().replace(/;\s*$/, '').trim();
  if (!statement) return { ok: false, reason: 'SQL 이 비어 있습니다' };
  let kind: 'read' | 'write' = 'read';
  let keyword = '';
  for (const backslashEscapes of [false, true]) {
    const scrubbed = scrubSql(statement, dialect, backslashEscapes);
    if (!scrubbed.ok) return scrubbed;
    if (scrubbed.text.includes(';')) return { ok: false, reason: '한 번에 한 문장만 실행할 수 있습니다' };
    const words = scrubbed.text.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? [];
    const head = words[0];
    if (head === undefined) return { ok: false, reason: 'SQL 이 비어 있습니다' };
    if (!keyword) keyword = head;
    // FOR SHARE / FOR KEY SHARE 는 행 잠금이다(FOR UPDATE 는 update 로 잡힌다).
    const rowLock = words.some((w, n) => w === 'for' && (words[n + 1] === 'share' || (words[n + 1] === 'key' && words[n + 2] === 'share')));
    if (!READ_HEADS.has(head) || rowLock || words.some((w) => WRITE_WORDS.has(w) || isSideEffectFunction(w))) {
      kind = 'write';
    }
  }
  return { ok: true, kind, keyword, statement };
}
