import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createClipboardTools } from '../src/tools/clipboard.js';
import { createOpenTools } from '../src/tools/open.js';
import { buildDefaultTools } from '../src/tools/index.js';
import type { ToolContext, ToolDef } from '../src/tools/types.js';

async function ctx(): Promise<ToolContext & { allowed: string }> {
  const allowed = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-misc-')));
  await writeFile(path.join(allowed, 'a.txt'), 'a');
  return { allowed, allowedDirs: [allowed], confirm: async () => true };
}

function byName(tools: ToolDef[]) {
  return Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>;
}

describe('clipboard', () => {
  it('읽기·쓰기와 메타', async () => {
    const deps = { read: vi.fn(async () => '복사한 글'), write: vi.fn(async () => undefined) };
    const tools = byName(createClipboardTools(deps));
    expect(tools.clipboard_read.readOnly && tools.clipboard_read.confirm === 'always').toBe(true);
    expect(!tools.clipboard_write.readOnly && tools.clipboard_write.confirm === 'never').toBe(true);
    const c = await ctx();
    expect(JSON.parse((( await tools.clipboard_read.run({}, c)).content[0] as { text: string }).text)).toEqual({ text: '복사한 글' });
    await tools.clipboard_write.run({ text: 'hi' }, c);
    expect(deps.write).toHaveBeenCalledWith('hi');
  });
});

describe('open', () => {
  it('open_path 는 http(s) URL 또는 허용 폴더 경로만', async () => {
    const deps = { openTarget: vi.fn(async () => undefined), openApp: vi.fn(async () => undefined) };
    const tools = byName(createOpenTools(deps));
    const c = await ctx();
    await tools.open_path.run({ target: 'https://studio.aeyes.dev' }, c);
    await tools.open_path.run({ target: 'a.txt' }, c);
    expect(deps.openTarget).toHaveBeenNthCalledWith(1, 'https://studio.aeyes.dev');
    expect(deps.openTarget).toHaveBeenNthCalledWith(2, path.join(c.allowed, 'a.txt'));
    const bad = await tools.open_path.run({ target: 'file:///etc/passwd' }, c);
    expect(bad.isError).toBe(true);
    const outside = await tools.open_path.run({ target: '/etc/hosts' }, c);
    expect(outside.isError).toBe(true);
    expect(deps.openTarget).toHaveBeenCalledTimes(2);
  });

  it('open_path 는 실행 파일·실행기 형식을 invalid_argument 로 거부한다', async () => {
    const deps = { openTarget: vi.fn(async () => undefined), openApp: vi.fn(async () => undefined) };
    const tools = byName(createOpenTools(deps));
    const c = await ctx();
    for (const name of ['evil.app', 'x.EXE', 'a.bat', 'a.cmd', 'a.com', 'a.ps1', 'a.vbs', 'a.js', 'a.jse', 'a.wsf', 'a.msi',
      'a.lnk', 'a.scr', 'a.command', 'a.sh', 'a.jar', 'a.pkg', 'a.dmg', 'a.workflow', 'a.terminal', 'a.url', 'a.desktop',
      'a.reg', 'a.hta', 'a.cpl']) {
      await writeFile(path.join(c.allowed, name), 'x');
      const r = await tools.open_path.run({ target: name }, c);
      expect(r.isError, name).toBe(true);
      expect(JSON.parse((r.content[0] as { text: string }).text).error, name).toBe('invalid_argument');
    }
    expect(deps.openTarget).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('open_path 는 실행 파일을 가리키는 심볼릭 링크도 거부한다', async () => {
    const deps = { openTarget: vi.fn(async () => undefined), openApp: vi.fn(async () => undefined) };
    const tools = byName(createOpenTools(deps));
    const c = await ctx();
    await writeFile(path.join(c.allowed, 'run.command'), 'x');
    await symlink(path.join(c.allowed, 'run.command'), path.join(c.allowed, 'doc.txt'));
    const r = await tools.open_path.run({ target: 'doc.txt' }, c);
    expect(r.isError).toBe(true);
    expect(deps.openTarget).not.toHaveBeenCalled();
  });

  it('open_app 확인 요약에 인자가 보인다', () => {
    const tools = byName(createOpenTools());
    expect(tools.open_app.summarize({ name: 'Terminal', args: ['-e', 'rm -rf ~'] })).toContain('rm -rf ~');
    expect(tools.open_app.summarize({ name: 'Terminal', args: ['-e', 'rm -rf ~'] })).toContain('Terminal');
  });

  it('open_app 은 이름과 인자를 넘긴다', async () => {
    const deps = { openTarget: vi.fn(async () => undefined), openApp: vi.fn(async () => undefined) };
    const tools = byName(createOpenTools(deps));
    await tools.open_app.run({ name: 'Microsoft Excel', args: ['--x'] }, await ctx());
    expect(deps.openApp).toHaveBeenCalledWith('Microsoft Excel', ['--x']);
    expect(tools.open_app.confirm).toBe('always');
  });
});

describe('buildDefaultTools', () => {
  it('1단계 도구 전체와 readOnlyHint 규칙', () => {
    const tools = buildDefaultTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'clipboard_read', 'clipboard_write', 'excel_read', 'excel_write', 'fs_delete', 'fs_list', 'fs_mkdir',
      'fs_move', 'fs_read', 'fs_search', 'fs_stat', 'fs_write', 'open_app', 'open_path', 'shell_exec',
    ]);
    expect(tools.filter((t) => t.readOnly).map((t) => t.name).sort()).toEqual([
      'clipboard_read', 'excel_read', 'fs_list', 'fs_read', 'fs_search', 'fs_stat',
    ]);
    expect(tools.filter((t) => t.confirm === 'always').map((t) => t.name).sort()).toEqual([
      'clipboard_read', 'fs_delete', 'fs_move', 'open_app', 'open_path', 'shell_exec',
    ]);
  });

  it('네이티브 드라이버·DB 설정이 있으면 3단계 도구를 더하고, 없으면 뺀다', () => {
    const screen = { listDisplays: async () => [], capture: async () => Buffer.alloc(0) };
    const input = { moveMouse: async () => undefined, click: async () => undefined, typeText: async () => undefined, pressKeys: async () => undefined };
    const driver = { execute: async () => ({ columns: [], rows: [], rowCount: 0, command: null, truncated: false }) };
    const tools = buildDefaultTools({
      native: { screen, input },
      databases: () => [{ name: 'shop', kind: 'postgres', connectionString: 'postgres://u:p@h/db', readOnly: true }],
      dbDrivers: { postgres: driver, mysql: driver },
    });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['screenshot', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'db_query']));
    expect(tools).toHaveLength(21);
    expect(tools.find((t) => t.name === 'db_query')?.readOnly).toBe(true);
    expect(tools.find((t) => t.name === 'db_query')?.confirm).toBe('conditional');
    const bare = buildDefaultTools({ native: { screen: null, input: null }, databases: () => [] }).map((t) => t.name);
    expect(bare).not.toContain('screenshot');
    expect(bare).not.toContain('mouse_move');
    expect(bare).not.toContain('db_query');
    expect(bare).toHaveLength(15);
  });
});
