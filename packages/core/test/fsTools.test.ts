import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFsTools } from '../src/tools/fs.js';
import type { ToolContext, ToolDef } from '../src/tools/types.js';

async function setup(confirmAnswer = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-fs-')));
  const allowed = path.join(root, 'allowed');
  await mkdir(path.join(allowed, 'sub'), { recursive: true });
  await writeFile(path.join(allowed, 'a.txt'), 'hello');
  await writeFile(path.join(allowed, 'sub', 'Report-2026.xlsx'), 'x');
  await writeFile(path.join(allowed, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(allowed, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  const trash = vi.fn(async () => undefined);
  const tools = Object.fromEntries(createFsTools({ trash }).map((t) => [t.name, t])) as Record<string, ToolDef>;
  const confirm = vi.fn(async () => confirmAnswer);
  const ctx: ToolContext = { allowedDirs: [allowed], confirm };
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await tools[name].run(args, ctx);
    const first = result.content[0];
    return { result, json: first.type === 'text' ? JSON.parse(first.text) : null };
  };
  return { allowed, tools, ctx, confirm, trash, run };
}

describe('fs 도구 메타', () => {
  it('이름·readOnly·확인 규칙', async () => {
    const { tools } = await setup();
    expect(Object.keys(tools).sort()).toEqual(['fs_delete', 'fs_list', 'fs_mkdir', 'fs_move', 'fs_read', 'fs_search', 'fs_stat', 'fs_write']);
    expect(['fs_list', 'fs_read', 'fs_stat', 'fs_search'].every((n) => tools[n].readOnly && tools[n].confirm === 'never')).toBe(true);
    expect(tools.fs_write.confirm).toBe('overwrite');
    expect(tools.fs_mkdir.confirm).toBe('never');
    expect(tools.fs_move.confirm).toBe('always');
    expect(tools.fs_delete.confirm).toBe('always');
  });
});

describe('읽기 도구', () => {
  it('fs_list 는 항목과 종류를 준다(기본 경로는 첫 허용 폴더)', async () => {
    const { run } = await setup();
    const { json } = await run('fs_list', {});
    expect(json.entries.map((e: { name: string }) => e.name).sort()).toEqual(['a.txt', 'bin.dat', 'img.png', 'sub']);
    expect(json.entries.find((e: { name: string }) => e.name === 'sub').type).toBe('dir');
  });

  it('fs_read 텍스트', async () => {
    const { run } = await setup();
    expect((await run('fs_read', { path: 'a.txt' })).json).toEqual({ path: expect.stringContaining('a.txt'), text: 'hello', truncated: false });
  });

  it('fs_read 1MB 초과 텍스트는 잘린다', async () => {
    const { run, allowed } = await setup();
    await writeFile(path.join(allowed, 'big.txt'), 'x'.repeat(1024 * 1024 + 10));
    const { json } = await run('fs_read', { path: 'big.txt' });
    expect(json.truncated).toBe(true);
    expect(json.text.length).toBe(1024 * 1024);
  });

  it('fs_read 이미지는 image 콘텐츠, 바이너리는 메타', async () => {
    const { tools, ctx, run } = await setup();
    const img = await tools.fs_read.run({ path: 'img.png' }, ctx);
    expect(img.content[0]).toEqual({ type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' });
    expect((await run('fs_read', { path: 'bin.dat' })).json).toEqual({ path: expect.any(String), binary: true, size: 4, mime: 'application/octet-stream' });
  });

  it('fs_search 는 이름 부분 일치(대소문자 무시)', async () => {
    const { run } = await setup();
    const { json } = await run('fs_search', { query: 'report' });
    expect(json.matches).toEqual([expect.stringContaining(path.join('sub', 'Report-2026.xlsx'))]);
  });

  it('허용 폴더 밖은 isError + path_not_allowed', async () => {
    const { tools, ctx } = await setup();
    const result = await tools.fs_read.run({ path: '../../etc/passwd' }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ error: 'path_not_allowed' });
  });
});

describe('쓰기 도구', () => {
  it('fs_write creates missing parents (새 파일은 확인 없음)', async () => {
    const { run, confirm, allowed } = await setup();
    const { json } = await run('fs_write', { path: 'new/deep/b.txt', content: 'hi' });
    expect(json).toMatchObject({ written: true, bytes: 2 });
    expect(await readFile(path.join(allowed, 'new', 'deep', 'b.txt'), 'utf8')).toBe('hi');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('fs_write 덮어쓰기는 확인, 거부하면 denied_locally', async () => {
    const denied = await setup(false);
    const result = await denied.tools.fs_write.run({ path: 'a.txt', content: 'bye' }, denied.ctx);
    expect(denied.confirm).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(await readFile(path.join(denied.allowed, 'a.txt'), 'utf8')).toBe('hello');
    const allowedRun = await setup(true);
    await allowedRun.tools.fs_write.run({ path: 'a.txt', content: 'bye' }, allowedRun.ctx);
    expect(await readFile(path.join(allowedRun.allowed, 'a.txt'), 'utf8')).toBe('bye');
  });

  it('fs_write base64', async () => {
    const { run, allowed } = await setup();
    await run('fs_write', { path: 'c.bin', content: Buffer.from([1, 2]).toString('base64'), encoding: 'base64' });
    expect([...(await readFile(path.join(allowed, 'c.bin')))]).toEqual([1, 2]);
  });

  it('fs_move 는 대상이 있으면 overwrite 없이는 실패', async () => {
    const { run, allowed } = await setup();
    await writeFile(path.join(allowed, 'd.txt'), 'd');
    const clash = await run('fs_move', { from: 'a.txt', to: 'd.txt' });
    expect(clash.result.isError).toBe(true);
    await run('fs_move', { from: 'a.txt', to: 'moved/a.txt' });
    expect(await readFile(path.join(allowed, 'moved', 'a.txt'), 'utf8')).toBe('hello');
  });

  it('fs_delete 는 휴지통으로 보내고 허용 폴더 루트는 거부', async () => {
    const { run, trash, allowed } = await setup();
    await run('fs_delete', { path: 'a.txt' });
    expect(trash).toHaveBeenCalledWith(path.join(allowed, 'a.txt'));
    const root = await run('fs_delete', { path: allowed });
    expect(root.result.isError).toBe(true);
    expect(trash).toHaveBeenCalledTimes(1);
  });

  it('fs_mkdir', async () => {
    const { run, allowed } = await setup();
    await run('fs_mkdir', { path: 'x/y' });
    expect((await stat(path.join(allowed, 'x', 'y'))).isDirectory()).toBe(true);
  });

  it('fs_move 는 대상이 허용 폴더 루트이면 거부', async () => {
    const { run, allowed } = await setup();
    const root = await run('fs_move', { from: 'a.txt', to: allowed, overwrite: true });
    expect(root.result.isError).toBe(true);
    expect(await readFile(path.join(allowed, 'a.txt'), 'utf8')).toBe('hello');
  });

  it('fs_write TOCTOU 방어: 부모 생성 후 symlink 공격 시 path_not_allowed', async () => {
    if (process.platform === 'win32') {
      // Windows 에서는 symlink 권한 이슈로 스킵
      return;
    }
    const { run, allowed } = await setup();
    const { symlinkSync } = await import('node:fs');
    const outside = path.dirname(allowed);
    const linkPath = path.join(allowed, 'link');
    try {
      symlinkSync(outside, linkPath, 'dir');
    } catch (error) {
      // macOS/Linux 에서 권한 이슈면 스킵 (회귀 방어용)
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }
    const result = await run('fs_write', { path: 'link/new.txt', content: 'bypass' });
    expect(result.result.isError).toBe(true);
    expect(JSON.parse((result.result.content[0] as { text: string }).text)).toMatchObject({ error: 'path_not_allowed' });
    // 파일이 실제로는 생성되지 않았는지 확인 (symlink 를 통해 밖에 기록되지 않았는지)
    expect(await readFile(linkPath, 'utf8').catch(() => 'not_found')).toBe('not_found');
  });
});
