/**
 * 셸 명령 실행. cwd 는 허용 폴더 안, 타임아웃이면 프로세스 트리를 종료, 출력은 합산 64KB.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { resolveAllowedPath } from '../paths.js';
import { defineTool, jsonResult, type ToolDef } from './types.js';

export const SHELL_OUTPUT_MAX = 64 * 1024;
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 300;

export function shellInvocation(
  platform: NodeJS.Platform = process.platform,
  zshExists: boolean = existsSync('/bin/zsh')
): { file: string; argsFor(command: string): string[] } {
  if (platform === 'win32') {
    return { file: 'powershell.exe', argsFor: (c) => ['-NoProfile', '-NonInteractive', '-Command', c] };
  }
  if (zshExists) return { file: '/bin/zsh', argsFor: (c) => ['-lc', c] };
  return { file: '/bin/sh', argsFor: (c) => ['-c', c] };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 종료됨 */ }
  }
}

export function createShellTools(): ToolDef[] {
  return [
    defineTool({
      name: 'shell_exec',
      description:
        '셸 명령을 실행한다(macOS/Linux zsh, Windows PowerShell). cwd 는 허용 폴더 안. 기본 60초 타임아웃, 출력 64KB 제한. PC 에서 확인을 받는다.',
      inputSchema: {
        command: z.string().min(1).max(8000),
        cwd: z.string().optional().describe('작업 폴더(기본 첫 허용 폴더)'),
        timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional(),
      },
      readOnly: false,
      confirm: 'always',
      summarize: (a) => String(a.command ?? ''),
      handler: async (args, ctx) => {
        const cwd = await resolveAllowedPath(args.cwd ?? ctx.allowedDirs[0], ctx.allowedDirs, { mustExist: true });
        const shell = shellInvocation();
        const timeoutMs = (args.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
        return new Promise((resolve) => {
          const child = spawn(shell.file, shell.argsFor(args.command), {
            cwd,
            env: process.env,
            windowsHide: true,
            detached: process.platform !== 'win32',
          });
          let stdout = '';
          let stderr = '';
          let truncated = false;
          let timedOut = false;
          const take = (chunk: Buffer, into: 'stdout' | 'stderr') => {
            const room = SHELL_OUTPUT_MAX - stdout.length - stderr.length;
            if (room <= 0) { truncated = true; return; }
            const text = chunk.toString('utf8');
            const part = text.length > room ? text.slice(0, room) : text;
            if (part.length < text.length) truncated = true;
            if (into === 'stdout') stdout += part; else stderr += part;
          };
          child.stdout?.on('data', (c: Buffer) => take(c, 'stdout'));
          child.stderr?.on('data', (c: Buffer) => take(c, 'stderr'));
          const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
          child.on('error', (error) => {
            clearTimeout(timer);
            resolve(jsonResult({ exitCode: null, signal: null, timedOut, truncated, stdout, stderr: `${stderr}${error.message}` }));
          });
          child.on('close', (exitCode, signal) => {
            clearTimeout(timer);
            resolve(jsonResult({ exitCode, signal, timedOut, truncated, stdout, stderr }));
          });
        });
      },
    }),
  ];
}
