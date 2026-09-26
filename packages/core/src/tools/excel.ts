/** 엑셀·CSV 읽기/쓰기(exceljs). 셀 값은 JSON 원시값으로 바꾼다(날짜는 ISO 문자열). */
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { resolveAllowedPath } from '../paths.js';
import { defineTool, jsonResult, type ToolDef } from './types.js';

type Cell = string | number | boolean | null;
const DEFAULT_MAX_ROWS = 500;
const HARD_MAX_ROWS = 5000;

function isCsv(file: string): boolean {
  return path.extname(file).toLowerCase() === '.csv';
}

function cellToJson(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) return v.richText.map((r) => String((r as { text?: unknown }).text ?? '')).join('');
    if ('result' in v) return cellToJson(v.result);
    if (typeof v.text === 'string') return v.text;
    if ('error' in v) return String(v.error);
  }
  return String(value);
}

export function createExcelTools(): ToolDef[] {
  const excelRead = defineTool({
    name: 'excel_read',
    description: 'xlsx 또는 csv 파일을 행 배열로 읽는다(첫 행이 보통 머리글).',
    inputSchema: {
      path: z.string().min(1).describe('파일 경로(.xlsx/.csv)'),
      sheet: z.string().optional().describe('시트 이름(기본 첫 시트, csv 는 무시)'),
      maxRows: z.number().int().min(1).max(HARD_MAX_ROWS).optional().describe('최대 행 수(기본 500)'),
    },
    readOnly: true,
    confirm: 'never',
    summarize: (a) => String(a.path),
    handler: async (args, ctx) => {
      const file = await resolveAllowedPath(args.path, ctx.allowedDirs, { mustExist: true });
      const workbook = new ExcelJS.Workbook();
      let worksheet: ExcelJS.Worksheet | undefined;
      if (isCsv(file)) {
        worksheet = await workbook.csv.readFile(file);
      } else {
        await workbook.xlsx.readFile(file);
        worksheet = args.sheet ? workbook.getWorksheet(args.sheet) : workbook.worksheets[0];
        if (!worksheet) throw new ToolError('invalid_argument', `시트가 없습니다: ${args.sheet ?? '(첫 시트)'}`);
      }
      const limit = args.maxRows ?? DEFAULT_MAX_ROWS;
      // 뒤쪽 빈 셀이 빠지지 않게 시트 전체 열 수만큼 채운다.
      const width = worksheet.columnCount;
      const rows: Cell[][] = [];
      let total = 0;
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        total += 1;
        if (rows.length >= limit) return;
        rows.push(Array.from({ length: width }, (_, i) => cellToJson(row.getCell(i + 1).value)));
      });
      return jsonResult({
        path: file,
        sheets: workbook.worksheets.map((w) => w.name),
        sheet: worksheet.name,
        rows,
        truncated: total > rows.length,
      });
    },
  });

  const excelWrite = defineTool({
    name: 'excel_write',
    description: '행 배열을 xlsx 또는 csv 로 저장한다. 기존 파일을 덮어쓰면 PC 에서 확인을 받는다.',
    inputSchema: {
      path: z.string().min(1).describe('파일 경로(.xlsx/.csv)'),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(HARD_MAX_ROWS),
      sheet: z.string().min(1).max(31).optional().describe('시트 이름(기본 Sheet1)'),
    },
    readOnly: false,
    confirm: 'overwrite',
    summarize: (a) => `덮어쓰기: ${String(a.path)}`,
    handler: async (args, ctx) => {
      const file = await resolveAllowedPath(args.path, ctx.allowedDirs);
      const exists = await stat(file).then(() => true, () => false);
      if (exists && !(await ctx.confirm(`덮어쓰기: ${file}`))) {
        throw new ToolError('denied_locally', '사용자가 PC 에서 거부했습니다');
      }
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(args.sheet ?? 'Sheet1');
      worksheet.addRows(args.rows);
      await mkdir(path.dirname(file), { recursive: true });
      if (isCsv(file)) await workbook.csv.writeFile(file);
      else await workbook.xlsx.writeFile(file);
      return jsonResult({ path: file, written: true, rows: args.rows.length });
    },
  });

  return [excelRead, excelWrite];
}
