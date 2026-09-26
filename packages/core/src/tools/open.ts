import open, { openApp } from 'open';
import path from 'node:path';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { resolveAllowedPath } from '../paths.js';
import { defineTool, jsonResult, type ToolDef } from './types.js';

export interface OpenDeps {
  openTarget(target: string): Promise<void>;
  openApp(name: string, args: string[]): Promise<void>;
}

const defaultDeps: OpenDeps = {
  openTarget: async (target) => { await open(target); },
  openApp: async (name, args) => { await openApp(name, { arguments: args }); },
};

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 열면 코드가 실행되거나 다른 프로그램을 띄우는 형식. open_path 로는 열지 않는다(앱 실행은 open_app 으로). */
const LAUNCHER_EXTENSIONS = new Set([
  '.app', '.exe', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.msi', '.lnk', '.scr', '.command',
  '.sh', '.jar', '.pkg', '.dmg', '.workflow', '.terminal', '.url', '.desktop', '.reg', '.hta', '.cpl',
]);

function isLauncher(file: string): boolean {
  // 끝의 구분자·점·공백은 Windows 가 무시하므로 떼고 본다(예: "a.exe." / "evil.app/").
  const trimmed = file.replace(/[\\/.\s]+$/, '');
  return LAUNCHER_EXTENSIONS.has(path.extname(trimmed).toLowerCase());
}

function describeArgs(args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return '';
  return ` (인자: ${args.map((a) => JSON.stringify(String(a))).join(' ')})`;
}

export function createOpenTools(deps: OpenDeps = defaultDeps): ToolDef[] {
  return [
    defineTool({
      name: 'open_path',
      description: '웹 주소(http/https)를 기본 브라우저로, 또는 허용 폴더 안의 파일·폴더를 기본 앱으로 연다.',
      inputSchema: { target: z.string().min(1).describe('http(s) URL 또는 경로') },
      readOnly: false,
      confirm: 'always',
      summarize: (a) => `열기: ${String(a.target)}`,
      handler: async (args, ctx) => {
        if (isWebUrl(args.target)) {
          await deps.openTarget(args.target);
          return jsonResult({ opened: args.target });
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(args.target)) {
          throw new ToolError('invalid_argument', 'http(s) 주소나 허용 폴더 경로만 열 수 있습니다');
        }
        const target = await resolveAllowedPath(args.target, ctx.allowedDirs, { mustExist: true });
        // 입력 이름과 링크를 따라간 실제 경로 모두 검사한다.
        if (isLauncher(args.target) || isLauncher(target)) {
          throw new ToolError('invalid_argument', '실행 파일·실행기 형식은 open_path 로 열 수 없습니다');
        }
        await deps.openTarget(target);
        return jsonResult({ opened: target });
      },
    }),
    defineTool({
      name: 'open_app',
      description: '설치된 앱을 이름으로 실행한다(예: "Microsoft Excel", "notepad").',
      inputSchema: {
        name: z.string().min(1).max(200),
        args: z.array(z.string().max(1000)).max(20).optional(),
      },
      readOnly: false,
      confirm: 'always',
      summarize: (a) => `앱 실행: ${String(a.name)}${describeArgs(a.args)}`,
      handler: async (args) => {
        await deps.openApp(args.name, args.args ?? []);
        return jsonResult({ launched: args.name });
      },
    }),
  ];
}
