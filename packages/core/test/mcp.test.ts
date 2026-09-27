import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLog } from '../src/audit.js';
import { createMcpServer } from '../src/mcp.js';
import { ConfigStore } from '../src/config.js';
import { ConfirmationGate } from '../src/policy/gate.js';
import type { ConfirmDecision } from '../src/policy/confirmer.js';
import { defineTool, jsonResult, type ToolDef } from '../src/tools/types.js';
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

describe('createMcpServer 입력 도구', () => {
  function fakeTool(name: string, ran: string[]): ToolDef {
    return defineTool({
      name, description: name, inputSchema: {}, readOnly: false, confirm: 'always',
      summarize: () => name,
      handler: async () => { ran.push(name); return jsonResult({ ok: true }); },
    });
  }

  async function connect(tools: ToolDef[], gate: ConfirmationGate, pairingId: string, dir: string) {
    const server = createMcpServer(tools, {
      allowedDirs: [dir], gate, audit: new AuditLog(path.join(dir, 'audit.log')),
      identity: { origin: 'https://studio.aeyes.dev', pairingId, accountLabel: 'a' },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(clientSide);
    return client;
  }

  it('다른 확인이 떠 있으면 세션 허용된 입력 도구도 busy 로 거부하고 실행하지 않는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-mcp-'));
    const store = await ConfigStore.open(path.join(dir, '.a'), dir);
    let release: (d: ConfirmDecision) => void = () => undefined;
    const gate = new ConfirmationGate(store, {
      confirm: (req) => req.tool === 'mouse_move'
        ? Promise.resolve<ConfirmDecision>('session')
        : new Promise<ConfirmDecision>((r) => { release = r; }),
    });
    const ran: string[] = [];
    const client = await connect([fakeTool('mouse_move', ran), fakeTool('shell_exec', ran)], gate, 'p1', dir);
    expect((await client.callTool({ name: 'mouse_move', arguments: {} })).isError).toBeFalsy();
    const shell = client.callTool({ name: 'shell_exec', arguments: {} });
    await new Promise((r) => setTimeout(r, 20));
    const blocked = await client.callTool({ name: 'mouse_move', arguments: {} });
    expect(blocked.isError).toBe(true);
    expect(JSON.parse((blocked.content as Array<{ text: string }>)[0].text).error).toBe('busy');
    expect(ran).toEqual(['mouse_move']);
    release('deny');
    await shell;
    const lines = (await readFile(path.join(dir, 'audit.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.tool}:${l.result}`)).toEqual(['mouse_move:ok', 'mouse_move:denied', 'shell_exec:denied']);
    await client.close();
  });

  it('세션 허용은 페어링별로 적용된다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aeyes-mcp-'));
    const store = await ConfigStore.open(path.join(dir, '.a'), dir);
    let asked = 0;
    const gate = new ConfirmationGate(store, { confirm: async () => { asked += 1; return 'session'; } });
    const ran: string[] = [];
    const a = await connect([fakeTool('mouse_move', ran)], gate, 'p1', dir);
    const b = await connect([fakeTool('mouse_move', ran)], gate, 'p2', dir);
    await a.callTool({ name: 'mouse_move', arguments: {} });
    await a.callTool({ name: 'mouse_move', arguments: {} });
    await b.callTool({ name: 'mouse_move', arguments: {} });
    expect(asked).toBe(2);
    expect(ran).toHaveLength(3);
    await a.close();
    await b.close();
  });
});
