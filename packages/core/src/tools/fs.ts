/**
 * 허용 폴더 파일 도구. 모든 경로는 resolveAllowedPath 를 거친다.
 * 삭제는 휴지통으로 보낸다(되돌릴 수 있게).
 */
import { mkdir, open, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import trashDefault from 'trash';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { isAllowedRoot, resolveAllowedPath } from '../paths.js';
import { defineTool, jsonResult, type ToolDef } from './types.js';

export interface FsDeps {
  trash(target: string): Promise<void>;
}

const TEXT_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const WRITE_MAX_BYTES = 10 * 1024 * 1024;
const LIST_MAX = 1000;
const SEARCH_MAX = 200;
const SEARCH_MAX_DEPTH = 8;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

const pathArg = (description: string) => z.string().min(1).describe(description);

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

function entryType(s: { isFile(): boolean; isDirectory(): boolean }): 'file' | 'dir' | 'other' {
  return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 검사를 마친 경로에 쓴다. 새 파일이면 'wx'(배타적 생성)로 열어, 검사와 쓰기 사이에 심어진
 * 심볼릭 링크를 따라가지 않고 실패하게 한다. 덮어쓰기는 호출자가 쓰기 직전에 realpath 로 재검사한다.
 */
export async function writeChecked(target: string, data: Buffer, overwrite: boolean): Promise<void> {
  try {
    await writeFile(target, data, { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ToolError('failed', '쓰는 사이에 같은 경로에 파일이 생겼습니다. 다시 시도하세요');
    }
    throw error;
  }
}

export function createFsTools(deps: FsDeps = { trash: (p) => trashDefault(p) }): ToolDef[] {
  const fsList = defineTool({
    name: 'fs_list',
    description: '허용 폴더 안의 폴더 내용을 나열한다. path 를 생략하면 첫 허용 폴더.',
    inputSchema: { path: z.string().optional().describe('폴더 경로(허용 폴더 기준 상대 또는 절대)') },
    readOnly: true,
    confirm: 'never',
    summarize: (a) => String(a.path ?? '.'),
    handler: async (args, ctx) => {
      const dir = await resolveAllowedPath(args.path ?? ctx.allowedDirs[0], ctx.allowedDirs, { mustExist: true });
      const names = (await readdir(dir)).slice(0, LIST_MAX);
      const entries = await Promise.all(names.map(async (name) => {
        const s = await stat(path.join(dir, name)).catch(() => null);
        return { name, type: s ? entryType(s) : 'other', size: s?.size ?? 0, mtime: s?.mtime.toISOString() ?? null };
      }));
      return jsonResult({ path: dir, entries, truncated: names.length >= LIST_MAX });
    },
  });

  const fsStat = defineTool({
    name: 'fs_stat',
    description: '파일·폴더 정보(종류, 크기, 수정 시각).',
    inputSchema: { path: pathArg('경로') },
    readOnly: true,
    confirm: 'never',
    summarize: (a) => String(a.path),
    handler: async (args, ctx) => {
      const target = await resolveAllowedPath(args.path, ctx.allowedDirs, { mustExist: true });
      const s = await stat(target);
      return jsonResult({ path: target, type: entryType(s), size: s.size, mtime: s.mtime.toISOString() });
    },
  });

  const fsRead = defineTool({
    name: 'fs_read',
    description: '파일을 읽는다. 텍스트는 최대 1MB, 이미지(png/jpg/gif/webp, 5MB 이하)는 이미지로, 그 외 바이너리는 크기 정보만.',
    inputSchema: { path: pathArg('파일 경로') },
    readOnly: true,
    confirm: 'never',
    summarize: (a) => String(a.path),
    handler: async (args, ctx) => {
      const target = await resolveAllowedPath(args.path, ctx.allowedDirs, { mustExist: true });
      const s = await stat(target);
      if (!s.isFile()) throw new ToolError('invalid_argument', '파일이 아닙니다');
      const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
      if (mime) {
        if (s.size > IMAGE_MAX_BYTES) throw new ToolError('too_large', '이미지가 5MB를 넘습니다');
        const data = await readHead(target, s.size);
        return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime }] };
      }
      const head = await readHead(target, Math.min(s.size, TEXT_MAX_BYTES));
      if (head.subarray(0, 8192).includes(0)) {
        return jsonResult({ path: target, binary: true, size: s.size, mime: 'application/octet-stream' });
      }
      return jsonResult({ path: target, text: head.toString('utf8'), truncated: s.size > TEXT_MAX_BYTES });
    },
  });

  const fsSearch = defineTool({
    name: 'fs_search',
    description: '허용 폴더 안에서 이름에 query 가 들어간 파일·폴더를 찾는다(대소문자 무시, 최대 200개).',
    inputSchema: {
      query: z.string().min(1).describe('찾을 이름 일부'),
      path: z.string().optional().describe('시작 폴더(기본 첫 허용 폴더)'),
    },
    readOnly: true,
    confirm: 'never',
    summarize: (a) => String(a.query),
    handler: async (args, ctx) => {
      const start = await resolveAllowedPath(args.path ?? ctx.allowedDirs[0], ctx.allowedDirs, { mustExist: true });
      const needle = args.query.toLowerCase();
      const matches: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > SEARCH_MAX_DEPTH || matches.length >= SEARCH_MAX) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (matches.length >= SEARCH_MAX) return;
          const full = path.join(dir, entry.name);
          if (entry.name.toLowerCase().includes(needle)) matches.push(full);
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full, depth + 1);
        }
      };
      await walk(start, 0);
      return jsonResult({ matches, truncated: matches.length >= SEARCH_MAX });
    },
  });

  const fsWrite = defineTool({
    name: 'fs_write',
    description: '파일을 쓴다(상위 폴더 자동 생성). 기존 파일을 덮어쓰면 PC 에서 확인을 받는다.',
    inputSchema: {
      path: pathArg('파일 경로'),
      content: z.string().describe('내용'),
      encoding: z.enum(['utf8', 'base64']).optional().describe('content 인코딩(기본 utf8)'),
    },
    readOnly: false,
    confirm: 'overwrite',
    summarize: (a) => `덮어쓰기: ${String(a.path)}`,
    handler: async (args, ctx) => {
      const target = await resolveAllowedPath(args.path, ctx.allowedDirs);
      const data = Buffer.from(args.content, args.encoding === 'base64' ? 'base64' : 'utf8');
      if (data.length > WRITE_MAX_BYTES) throw new ToolError('too_large', '10MB를 넘는 파일은 쓸 수 없습니다');
      const existed = await exists(target);
      if (existed) {
        if ((await stat(target)).isDirectory()) throw new ToolError('invalid_argument', '폴더 경로입니다');
        if (!(await ctx.confirm(`덮어쓰기: ${target}`))) throw new ToolError('denied_locally', '사용자가 PC 에서 거부했습니다');
      }
      await mkdir(path.dirname(target), { recursive: true });
      // TOCTOU 방어: 부모 디렉토리 생성 후(덮어쓰기면 확인 대기 후) 쓰기 직전에 경로 재검사
      const recheckedTarget = await resolveAllowedPath(args.path, ctx.allowedDirs, { mustExist: existed });
      await writeChecked(recheckedTarget, data, existed);
      return jsonResult({ path: recheckedTarget, written: true, bytes: data.length });
    },
  });

  const fsMkdir = defineTool({
    name: 'fs_mkdir',
    description: '폴더를 만든다(상위 포함).',
    inputSchema: { path: pathArg('폴더 경로') },
    readOnly: false,
    confirm: 'never',
    summarize: (a) => String(a.path),
    handler: async (args, ctx) => {
      const target = await resolveAllowedPath(args.path, ctx.allowedDirs);
      // TOCTOU 방어: 경로 재검사 후 생성
      const recheckedTarget = await resolveAllowedPath(args.path, ctx.allowedDirs);
      await mkdir(recheckedTarget, { recursive: true });
      return jsonResult({ path: recheckedTarget, created: true });
    },
  });

  const fsMove = defineTool({
    name: 'fs_move',
    description: '파일·폴더를 이동하거나 이름을 바꾼다(허용 폴더 안에서만). 대상이 있으면 overwrite:true 가 필요하다.',
    inputSchema: {
      from: pathArg('원래 경로'),
      to: pathArg('새 경로'),
      overwrite: z.boolean().optional(),
    },
    readOnly: false,
    confirm: 'always',
    summarize: (a) => `${String(a.from)} → ${String(a.to)}`,
    handler: async (args, ctx) => {
      const from = await resolveAllowedPath(args.from, ctx.allowedDirs, { mustExist: true });
      const to = await resolveAllowedPath(args.to, ctx.allowedDirs);
      if (await isAllowedRoot(from, ctx.allowedDirs)) throw new ToolError('invalid_argument', '허용 폴더 자체는 옮길 수 없습니다');
      if (await isAllowedRoot(to, ctx.allowedDirs)) throw new ToolError('invalid_argument', '허용 폴더 자체로는 옮길 수 없습니다');
      if ((await exists(to)) && args.overwrite !== true) throw new ToolError('invalid_argument', '대상 경로가 이미 있습니다');
      await mkdir(path.dirname(to), { recursive: true });
      // TOCTOU 방어: 부모 디렉토리 생성 후 경로 재검사
      const recheckedFrom = await resolveAllowedPath(args.from, ctx.allowedDirs, { mustExist: true });
      const recheckedTo = await resolveAllowedPath(args.to, ctx.allowedDirs);
      await rename(recheckedFrom, recheckedTo);
      return jsonResult({ from: recheckedFrom, to: recheckedTo, moved: true });
    },
  });

  const fsDelete = defineTool({
    name: 'fs_delete',
    description: '파일·폴더를 휴지통으로 보낸다.',
    inputSchema: { path: pathArg('경로') },
    readOnly: false,
    confirm: 'always',
    summarize: (a) => `삭제(휴지통): ${String(a.path)}`,
    handler: async (args, ctx) => {
      const target = await resolveAllowedPath(args.path, ctx.allowedDirs, { mustExist: true });
      if (await isAllowedRoot(target, ctx.allowedDirs)) throw new ToolError('invalid_argument', '허용 폴더 자체는 지울 수 없습니다');
      await deps.trash(target);
      return jsonResult({ path: target, trashed: true });
    },
  });

  return [fsList, fsStat, fsRead, fsSearch, fsWrite, fsMkdir, fsMove, fsDelete];
}
