import { request } from 'node:http';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigStore } from '../src/config.js';
import { startAgent, type RunningAgent } from '../src/server.js';
import type { Confirmer } from '../src/policy/confirmer.js';

const ORIGIN = 'https://studio.aeyes.dev';
let agent: RunningAgent | null = null;
afterEach(async () => { await agent?.close(); agent = null; });

async function boot(confirmer: Confirmer = { confirm: async () => 'allow' }, dev = false) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-srv-')));
  const store = await ConfigStore.open(path.join(home, '.a'), home);
  agent = await startAgent({ store, confirmer, dev, auditFile: path.join(home, '.a', 'audit.log') });
  return { home, store, agent, base: `http://127.0.0.1:${agent.port}`, allowed: store.get().allowedDirs[0], audit: path.join(home, '.a', 'audit.log') };
}

async function pair(base: string, a: RunningAgent) {
  const { code } = a.pairing.createCode();
  const res = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ code, accountLabel: 'ky***@gmail.com', browserLabel: 'Chrome' }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}

function rawRequest(port: number, opts: { method: string; path: string; headers: Record<string, string> }) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, ...opts }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

async function mcpClient(base: string, token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } },
  }));
  return client;
}

describe('보안 검사', () => {
  it('127.0.0.1 에 47821~47830 포트로 뜬다', async () => {
    const { agent: a } = await boot();
    expect(a.port).toBeGreaterThanOrEqual(47821);
    expect(a.port).toBeLessThanOrEqual(47830);
  });

  it('Host 헤더가 다르면 403 (DNS 리바인딩)', async () => {
    const { agent: a } = await boot();
    expect(await rawRequest(a.port, { method: 'GET', path: '/health', headers: { host: `evil.com:${a.port}`, origin: ORIGIN } })).toBe(403);
  });

  it('Origin 이 없거나 허용 밖이면 403', async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/health`)).status).toBe(403);
    expect((await fetch(`${base}/health`, { headers: { origin: 'https://evil.example.com' } })).status).toBe(403);
    expect((await fetch(`${base}/health`, { headers: { origin: 'http://localhost:3000' } })).status).toBe(403);
  });

  it('dev 에서는 localhost origin 허용', async () => {
    const { base } = await boot(undefined, true);
    expect((await fetch(`${base}/health`, { headers: { origin: 'http://localhost:3000' } })).status).toBe(200);
  });

  it('health 는 CORS 헤더와 페어링 여부', async () => {
    const { base, agent: a } = await boot();
    const res = await fetch(`${base}/health`, { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('vary')).toContain('Origin');
    expect(await res.json()).toEqual({ name: 'aeyes-local-agent', version: '0.1.0', paired: false });
    await pair(base, a);
    expect((await (await fetch(`${base}/health`, { headers: { origin: ORIGIN } })).json()).paired).toBe(true);
  });

  it('preflight 는 사설망 허용 헤더로 204', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
        'access-control-request-private-network': 'true',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('토큰 없거나 틀리면 401', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const wrong = await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: ORIGIN, authorization: 'Bearer x', 'content-type': 'application/json' }, body: '{}' });
    expect(wrong.status).toBe(401);
  });

  it('잘못된 코드 401, 잠금 423', async () => {
    const { base, agent: a } = await boot();
    a.pairing.createCode();
    const send = () => fetch(`${base}/pair`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abcdef', accountLabel: '', browserLabel: '' }) });
    for (let i = 0; i < 5; i += 1) expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(423);
  });

  it('/pair 본문이 객체가 아니면(null·배열·숫자) 400 invalid_json', async () => {
    const { base, agent: a } = await boot();
    a.pairing.createCode();
    for (const body of ['null', '[]', '42', '"x"']) {
      const res = await fetch(`${base}/pair`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body });
      expect(res.status, body).toBe(400);
      expect((await res.json()).error).toBe('invalid_json');
    }
  });

  it('본문 2MB 초과는 413', async () => {
    const { base, agent: a } = await boot();
    const token = await pair(base, a);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'x'.repeat(2 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it('DELETE /pair 는 그 토큰을 무효화', async () => {
    const { base, agent: a } = await boot();
    const token = await pair(base, a);
    const res = await fetch(`${base}/pair`, { method: 'DELETE', headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    expect(res.status).toBe(204);
    expect(a.pairing.verify(token)).toBeNull();
  });
});

describe('MCP', () => {
  it('tools/list 에 1단계 도구와 readOnlyHint', async () => {
    const { base, agent: a } = await boot();
    const client = await mcpClient(base, await pair(base, a));
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toContain('shell_exec');
    expect(byName.fs_read.annotations?.readOnlyHint).toBe(true);
    expect(byName.fs_write.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });

  it('fs_write → fs_read 왕복과 감사 로그', async () => {
    const { base, agent: a, allowed, audit } = await boot();
    const client = await mcpClient(base, await pair(base, a));
    await client.callTool({ name: 'fs_write', arguments: { path: 'note.txt', content: '비밀내용' } });
    const read = await client.callTool({ name: 'fs_read', arguments: { path: 'note.txt' } });
    expect(JSON.parse((read.content as Array<{ text: string }>)[0].text).text).toBe('비밀내용');
    expect(await readFile(path.join(allowed, 'note.txt'), 'utf8')).toBe('비밀내용');
    const log = await readFile(audit, 'utf8');
    expect(log).toContain('"tool":"fs_write"');
    expect(log).toContain(`"origin":"${ORIGIN}"`);
    expect(log).not.toContain('비밀내용');
    await client.close();
  });

  it('확인 필요 도구는 거부 시 denied_locally 이고 실행되지 않는다', async () => {
    const seen: string[] = [];
    const { base, agent: a, allowed } = await boot({ confirm: async (req) => { seen.push(`${req.tool}|${req.summary}|${req.accountLabel}`); return 'deny'; } });
    const client = await mcpClient(base, await pair(base, a));
    const result = await client.callTool({ name: 'shell_exec', arguments: { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"' } });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).error).toBe('denied_locally');
    expect(seen[0]).toMatch(/^shell_exec\|node -e .*\|ky\*\*\*@gmail\.com$/);
    await expect(readFile(path.join(allowed, 'ran.txt'), 'utf8')).rejects.toThrow();
    await client.close();
  });

  it('설정 폴더가 허용 폴더 안에 있어도 파일 도구로 접근할 수 없다', async () => {
    const { base, agent: a, store, home } = await boot();
    await store.update((c) => { c.allowedDirs = [home]; });
    const client = await mcpClient(base, await pair(base, a));
    for (const [name, args] of [
      ['fs_read', { path: '.a/config.json' }],
      ['fs_write', { path: '.a/config.json', content: '{}' }],
      ['fs_write', { path: '.a/new.txt', content: 'x' }],
      ['fs_list', { path: '.a' }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(JSON.parse((r.content as Array<{ text: string }>)[0].text).error, `${name} ${JSON.stringify(args)}`).toBe('path_not_allowed');
    }
    const search = await client.callTool({ name: 'fs_search', arguments: { query: 'config' } });
    expect(JSON.parse((search.content as Array<{ text: string }>)[0].text).matches).toEqual([]);
    await client.close();
  });

  it('항상 허용이면 두 번째는 묻지 않는다', async () => {
    let asked = 0;
    const { base, agent: a } = await boot({ confirm: async () => { asked += 1; return 'always'; } });
    const client = await mcpClient(base, await pair(base, a));
    await client.callTool({ name: 'shell_exec', arguments: { command: 'echo 1' } });
    await client.callTool({ name: 'shell_exec', arguments: { command: 'echo 2' } });
    expect(asked).toBe(1);
    await client.close();
  });

  it('항상 허용된 명령이라도 연결·치환·인터프리터 명령은 다시 묻고 기록하지 않는다', async () => {
    const asked: string[] = [];
    const { base, agent: a, store, allowed } = await boot({ confirm: async (req) => { asked.push(req.summary); return req.alwaysAllowed ? 'always' : 'deny'; } });
    const client = await mcpClient(base, await pair(base, a));
    await client.callTool({ name: 'shell_exec', arguments: { command: 'echo 1' } });
    const chained = await client.callTool({ name: 'shell_exec', arguments: { command: 'echo 1; node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"' } });
    expect(JSON.parse((chained.content as Array<{ text: string }>)[0].text).error).toBe('denied_locally');
    await client.callTool({ name: 'shell_exec', arguments: { command: 'node -e "1"' } });
    expect(asked).toHaveLength(3);
    expect(store.get().alwaysAllow.map((r) => r.key)).toEqual(['shell_exec:echo']);
    await expect(readFile(path.join(allowed, 'ran.txt'), 'utf8')).rejects.toThrow();
    await client.close();
  });
});
