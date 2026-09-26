/**
 * 허용 폴더 경로 해석. 모든 파일 도구는 이 함수를 거친다.
 * realpath 로 심볼릭 링크를 끝까지 따라간 실제 경로가 허용 폴더 안이어야 한다.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './errors.js';

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function caseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function isWithin(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathApi(platform);
  const norm = (value: string) => {
    const resolved = p.resolve(value);
    return caseInsensitive(platform) ? resolved.toLowerCase() : resolved;
  };
  const rel = p.relative(norm(parent), norm(child));
  if (rel === '') return true;
  if (p.isAbsolute(rel)) return false;
  return rel.split(p.sep)[0] !== '..';
}

/** 실제 경로를 구한다. 없으면 가장 가까운 존재하는 상위의 realpath 에 나머지를 붙인다(exists=false). */
async function realpathOfNearest(target: string): Promise<{ real: string; exists: boolean }> {
  try {
    return { real: await realpath(target), exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new ToolError('failed', `경로를 확인할 수 없습니다: ${code ?? 'unknown'}`);
  }
  const rest: string[] = [];
  let current = target;
  for (;;) {
    const parent = path.dirname(current);
    rest.unshift(path.basename(current));
    if (parent === current) throw new ToolError('not_found', `경로를 확인할 수 없습니다: ${target}`);
    try {
      return { real: path.join(await realpath(parent), ...rest), exists: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ToolError('failed', '경로를 확인할 수 없습니다');
      }
      current = parent;
    }
  }
}

async function realAllowedDirs(allowedDirs: string[]): Promise<string[]> {
  return Promise.all(allowedDirs.map((d) => realpath(d).catch(() => path.resolve(d))));
}

export async function resolveAllowedPath(
  input: string,
  allowedDirs: string[],
  opts: { mustExist?: boolean } = {}
): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    throw new ToolError('invalid_argument', '경로가 비어 있거나 올바르지 않습니다');
  }
  if (allowedDirs.length === 0) throw new ToolError('path_not_allowed', '허용된 폴더가 없습니다');
  const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(allowedDirs[0], input);
  const { real, exists } = await realpathOfNearest(absolute);
  const roots = await realAllowedDirs(allowedDirs);
  // 허용 여부를 존재 여부보다 먼저 판정한다 — 밖의 경로가 "없음"으로 새어 나가 존재 여부를 알려 주지 않게.
  if (!roots.some((root) => isWithin(real, root))) {
    throw new ToolError('path_not_allowed', `허용된 폴더 밖의 경로입니다: ${input}`);
  }
  if (opts.mustExist && !exists) throw new ToolError('not_found', `파일이 없습니다: ${input}`);
  return real;
}

/** 허용 폴더 자체(루트)인지. 루트 삭제·이동을 막는 데 쓴다. */
export async function isAllowedRoot(real: string, allowedDirs: string[]): Promise<boolean> {
  const roots = await realAllowedDirs(allowedDirs);
  return roots.some((root) => isWithin(real, root) && isWithin(root, real));
}
