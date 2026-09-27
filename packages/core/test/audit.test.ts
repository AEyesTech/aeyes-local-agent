import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog, summarizeArgs } from '../src/audit.js';

describe('summarizeArgs', () => {
  it('경로·명령 등만 남기고 내용은 뺀다', () => {
    const s = summarizeArgs({ path: 'a.txt', content: 'SECRET', command: 'x'.repeat(300), rows: [[1]], text: 'clip' });
    expect(s).toContain('"path":"a.txt"');
    expect(s).not.toContain('SECRET');
    expect(s).not.toContain('clip');
    expect(s).not.toContain('rows');
    expect(JSON.parse(s).command).toHaveLength(120);
  });

  it('db_query 는 DB 이름과 SQL 앞 120자만 남긴다', () => {
    const s = JSON.parse(summarizeArgs({ database: 'shop', sql: 'S'.repeat(300), maxRows: 5 }));
    expect(s).toEqual({ database: 'shop', sql: 'S'.repeat(120) });
  });

  it('db_query 요약에 연결 문자열이 들어가지 않는다', () => {
    const s = summarizeArgs({ database: 'shop', sql: 'SELECT 1', connectionString: 'postgres://u:SECRETPW@h/db' });
    expect(s).not.toContain('SECRETPW');
  });
});

describe('AuditLog', () => {
  it('한 줄 JSON 으로 쓰고 크기 초과 시 회전한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-audit-'));
    const file = path.join(dir, 'audit.log');
    const log = new AuditLog(file, 300);
    const entry = { tool: 'fs_read', origin: 'https://studio.aeyes.dev', pairingId: 'p1', result: 'ok' as const, ms: 3, args: '{"path":"a"}' };
    await log.write(entry);
    const line = JSON.parse((await readFile(file, 'utf8')).trim());
    expect(line).toMatchObject(entry);
    expect(typeof line.ts).toBe('string');
    for (let i = 0; i < 5; i += 1) await log.write(entry);
    expect((await stat(`${file}.1`)).size).toBeGreaterThan(0);
    expect((await stat(file)).size).toBeLessThanOrEqual(300);
  });
});
