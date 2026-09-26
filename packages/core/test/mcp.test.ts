import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLog } from '../src/audit.js';
import { createMcpServer } from '../src/mcp.js';
import type { ConfirmationGate } from '../src/policy/gate.js';
import { buildDefaultTools } from '../src/tools/index.js';

describe('createMcpServer 감사 로그', () => {
  it('확인 게이트가 예외를 던져도 감사 로그를 남기고 실행하지 않는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-mcp-'));
    const auditFile = path.join(dir, 'audit.log');
    const gate = { check: async () => { throw new Error('config write failed'); } } as unknown as ConfirmationGate;
    const server = createMcpServer(buildDefaultTools(), {
      allowedDirs: [dir],
      gate,
      audit: new AuditLog(auditFile),
      identity: { origin: 'https://studio.aeyes.dev', pairingId: 'p1', accountLabel: 'a' },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(clientSide);
    const result = await client.callTool({ name: 'fs_delete', arguments: { path: 'x' } });
    expect(result.isError).toBe(true);
    const lines = (await readFile(auditFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'fs_delete', result: 'error', pairingId: 'p1' });
    await client.close();
  });
});
