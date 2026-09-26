import { access, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createExcelTools } from '../src/tools/excel.js';
import type { ToolContext, ToolDef } from '../src/tools/types.js';

async function setup(confirmAnswer = true) {
  const allowed = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-xl-')));
  const tools = Object.fromEntries(createExcelTools().map((t) => [t.name, t])) as Record<string, ToolDef>;
  const confirm = vi.fn(async () => confirmAnswer);
  const ctx: ToolContext = { allowedDirs: [allowed], confirm };
  const run = async (name: string, args: Record<string, unknown>) => {
    const r = await tools[name].run(args, ctx);
    return { r, json: JSON.parse((r.content[0] as { text: string }).text) };
  };
  return { allowed, tools, confirm, run };
}

describe('excel 도구', () => {
  it('xlsx 쓰기 → 읽기 왕복', async () => {
    const { run } = await setup();
    const rows = [['상품명', '가격', '재고'], ['티셔츠', 19000, true], ['모자', 12000.5, null]];
    expect((await run('excel_write', { path: 'p.xlsx', rows, sheet: '상품' })).json).toMatchObject({ written: true, rows: 3 });
    const { json } = await run('excel_read', { path: 'p.xlsx' });
    expect(json.sheets).toEqual(['상품']);
    expect(json.sheet).toBe('상품');
    expect(json.rows).toEqual(rows);
    expect(json.truncated).toBe(false);
  });

  it('csv 읽기와 maxRows', async () => {
    const { run, allowed } = await setup();
    await writeFile(path.join(allowed, 'a.csv'), 'a,b\n1,2\n3,4\n5,6\n');
    const { json } = await run('excel_read', { path: 'a.csv', maxRows: 2 });
    expect(json.rows).toEqual([['a', 'b'], [1, 2]]);
    expect(json.truncated).toBe(true);
  });

  it('없는 시트는 invalid_argument', async () => {
    const { run } = await setup();
    await run('excel_write', { path: 'p.xlsx', rows: [['x']] });
    const { r, json } = await run('excel_read', { path: 'p.xlsx', sheet: 'nope' });
    expect(r.isError).toBe(true);
    expect(json.error).toBe('invalid_argument');
  });

  it('덮어쓰기는 확인을 거친다', async () => {
    const { run, confirm } = await setup(false);
    await run('excel_write', { path: 'p.xlsx', rows: [['x']] });
    expect(confirm).not.toHaveBeenCalled();
    const { r } = await run('excel_write', { path: 'p.xlsx', rows: [['y']] });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('excel_write 는 밖을 가리키는 끊어진 링크에 쓰지 않는다', async () => {
    const { run, allowed } = await setup();
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-xl-out-')));
    await symlink(path.join(outside, 'planted.xlsx'), path.join(allowed, 'd.xlsx'));
    await symlink(path.join(outside, 'planted.csv'), path.join(allowed, 'd.csv'));
    for (const p of ['d.xlsx', 'd.csv']) {
      const { r, json } = await run('excel_write', { path: p, rows: [['x']] });
      expect(r.isError).toBe(true);
      expect(json.error).toBe('path_not_allowed');
    }
    await expect(access(path.join(outside, 'planted.xlsx'))).rejects.toThrow();
    await expect(access(path.join(outside, 'planted.csv'))).rejects.toThrow();
  });

  it('csv 쓰기 → 읽기 왕복(새 파일)', async () => {
    const { run } = await setup();
    expect((await run('excel_write', { path: 'n.csv', rows: [['a', 'b'], [1, 2]] })).json).toMatchObject({ written: true });
    expect((await run('excel_read', { path: 'n.csv' })).json.rows).toEqual([['a', 'b'], [1, 2]]);
  });
});
