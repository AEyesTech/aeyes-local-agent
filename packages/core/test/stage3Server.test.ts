import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigStore } from '../src/config.js';
import type { InputDriver, NativeDrivers } from '../src/native.js';
import type { Confirmer } from '../src/policy/confirmer.js';
import { startAgent, type RunningAgent } from '../src/server.js';

const ORIGIN = 'https://studio.aeyes.dev';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
let agent: RunningAgent | null = null;
afterEach(async () => { await agent?.close(); agent = null; });

async function boot(confirmer: Confirmer, native: NativeDrivers, databases: unknown[] = []) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-s3-')));
  const store = await ConfigStore.open(path.join(home, '.a'), home);
  if (databases.length > 0) {
    await store.update((c) => { c.databases = databases as typeof c.databases; });
  }
  agent = await startAgent({ store, confirmer, native, auditFile: path.join(home, '.a', 'audit.log') });
  const base = `http://127.0.0.1:${agent.port}`;
  const { code } = agent.pairing.createCode();
  const res = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ code, accountLabel: 'ky***', browserLabel: 'Chrome' }),
  });
  const { token } = (await res.json()) as { token: string };
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } },
  }));
  return { store, client, agent };
}

function inputDriver(calls: string[]): InputDriver {
  return {
    moveMouse: async (x, y) => { calls.push(`move ${x},${y}`); },
    click: async () => undefined,
    typeText: async () => undefined,
    pressKeys: async () => undefined,
  };
}

describe('3단계 도구 연결', () => {
  it('세션 허용이 HTTP 경로에서도 동작하고 설정에 남지 않는다', async () => {
    const calls: string[] = [];
    const confirm = vi.fn(async () => 'session' as const);
    const screen = { listDisplays: async () => [{ id: 0, name: '주' }], capture: async () => PNG };
    const { store, client, agent: a } = await boot({ confirm }, { screen, input: inputDriver(calls) });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['screenshot', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press']));
    expect(names).not.toContain('db_query');
    expect(await a.toolNames()).toContain('screenshot');
    await client.callTool({ name: 'mouse_move', arguments: { x: 1, y: 2 } });
    await client.callTool({ name: 'mouse_move', arguments: { x: 3, y: 4 } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['move 1,2', 'move 3,4']);
    expect(a.sessionGrantCount()).toBe(1);
    expect(store.get().alwaysAllow).toEqual([]);
    expect(a.clearSessionGrants()).toBe(1);
    await client.callTool({ name: 'mouse_move', arguments: { x: 5, y: 6 } });
    expect(confirm).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it('네이티브 없으면 화면·입력 도구가 없고, DB 설정이 있으면 db_query 가 있다', async () => {
    const { client, agent: a } = await boot({ confirm: async () => 'deny' }, { screen: null, input: null }, [
      { name: 'shop', kind: 'postgres', connectionString: 'postgres://u:p@127.0.0.1:1/db', readOnly: true },
    ]);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('screenshot');
    expect(names).not.toContain('mouse_move');
    expect(names).toContain('db_query');
    expect(tools.find((t) => t.name === 'db_query')?.annotations?.readOnlyHint).toBe(true);
    expect(await a.toolNames()).toContain('db_query');
    await client.close();
  });
});
