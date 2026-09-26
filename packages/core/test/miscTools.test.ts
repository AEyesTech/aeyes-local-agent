import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
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
});
