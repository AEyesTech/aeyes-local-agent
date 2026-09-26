/**
 * 셸 명령 실행. cwd 는 허용 폴더 안, 타임아웃이면 프로세스 트리를 종료, 출력은 합산 64KB(바이트 기준).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { resolveAllowedPath } from '../paths.js';
import { defineTool, jsonResult, type ToolDef } from './types.js';

export const SHELL_OUTPUT_MAX = 64 * 1024;
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 300;
/** 'exit' 이후 'close'(stdio 드레인)를 기다리는 유예 시간. 백그라운드 손자 프로세스가 파이프를 물고 있으면 'close'가 영영 오지 않을 수 있다. */
const CLOSE_GRACE_MS = 1000;

/** PowerShell 출력이 한글 등에서 깨지지 않게 UTF-8 로 바꾼 뒤 명령을 실행하고 종료 코드를 넘긴다.
 *  명령은 따옴표 처리 문제를 피하려고 UTF-16LE base64(-EncodedCommand)로 넘긴다.
 *  명령을 별도 줄에 두어 끝의 주석(#)이 exit 줄을 삼키지 않게 한다. */
const POWERSHELL_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8;';

function encodePowerShell(command: string): string {
  const script = `${POWERSHELL_PREFIX}\n${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function shellInvocation(
  platform: NodeJS.Platform = process.platform,
  zshExists: boolean = existsSync('/bin/zsh')
): { file: string; argsFor(command: string): string[] } {
  if (platform === 'win32') {
    return { file: 'powershell.exe', argsFor: (c) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(c)] };
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
        const cwd = await resolveAllowedPath(args.cwd ?? ctx.allowedDirs[0], ctx.allowedDirs, { mustExist: true, deniedDirs: ctx.deniedDirs });
        const shell = shellInvocation();
        const timeoutMs = (args.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
        return new Promise((resolve) => {
          const child = spawn(shell.file, shell.argsFor(args.command), {
            cwd,
            env: process.env,
            // 입력을 기다리는 명령이 타임아웃까지 멈춰 있지 않도록 stdin 은 닫아 둔다.
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
          });
          // 청크 경계에서 멀티바이트 문자가 잘리지 않도록 스트림별로 디코더를 유지한다.
          let stdoutStr = '';
          let stderrStr = '';
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let stdoutTruncated = false;
          let stderrTruncated = false;
          let timedOut = false;
          let settled = false;
          const stdoutDecoder = new StringDecoder('utf8');
          const stderrDecoder = new StringDecoder('utf8');

          const take = (chunk: Buffer, into: 'stdout' | 'stderr') => {
            // 합산 64KB 는 문자열 길이(UTF-16)가 아니라 바이트 기준으로 잰다.
            const room = SHELL_OUTPUT_MAX - (stdoutBytes + stderrBytes);
            if (room <= 0) {
              if (into === 'stdout') stdoutTruncated = true; else stderrTruncated = true;
              return;
            }
            const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
            const cut = part.length < chunk.length;
            if (into === 'stdout') {
              stdoutStr += stdoutDecoder.write(part);
              stdoutBytes += part.length;
              if (cut) stdoutTruncated = true;
            } else {
              stderrStr += stderrDecoder.write(part);
              stderrBytes += part.length;
              if (cut) stderrTruncated = true;
            }
          };
          child.stdout?.on('data', (c: Buffer) => take(c, 'stdout'));
          child.stderr?.on('data', (c: Buffer) => take(c, 'stderr'));

          const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
          let graceTimer: NodeJS.Timeout | undefined;

          const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            // 잘리지 않은 스트림만 디코더를 flush 한다 — 잘린 경우 남은 부분 바이트는
            // 완결되지 않은 문자일 수 있으므로 그대로 버려 깨진 문자가 섞이지 않게 한다.
            if (!stdoutTruncated) stdoutStr += stdoutDecoder.end();
            if (!stderrTruncated) stderrStr += stderrDecoder.end();
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(jsonResult({
              exitCode,
              signal,
              timedOut,
              truncated: stdoutTruncated || stderrTruncated,
              stdout: stdoutStr,
              stderr: stderrStr,
            }));
          };

          child.on('error', (error) => {
            stderrStr += error.message;
            finish(null, null);
          });
          child.on('exit', (exitCode, signal) => {
            // 손자 프로세스가 stdio 를 물고 있으면 'close' 가 오지 않을 수 있다 —
            // 짧은 유예 후에도 오지 않으면 지금까지 모은 출력으로 마무리한다.
            graceTimer = setTimeout(() => finish(exitCode, signal), CLOSE_GRACE_MS);
          });
          child.on('close', (exitCode, signal) => {
            finish(exitCode, signal);
          });
        });
      },
    }),
  ];
}
