import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createShellTools, SHELL_OUTPUT_MAX, shellInvocation } from '../src/tools/shell.js';
import type { ToolContext } from '../src/tools/types.js';

async function setup() {
  const allowed = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-sh-')));
  await mkdir(path.join(allowed, 'work'));
  const [tool] = createShellTools();
  const ctx: ToolContext = { allowedDirs: [allowed], confirm: async () => true };
  const run = async (args: Record<string, unknown>) => {
    const r = await tool.run(args, ctx);
    return { r, json: JSON.parse((r.content[0] as { text: string }).text) };
  };
  return { allowed, tool, run };
}

// node -e 는 zsh·sh·powershell 어디서나 같은 방식으로 동작한다.
const node = (code: string) => `node -e "${code}"`;

describe('shellInvocation', () => {
  it('플랫폼별 셸', () => {
    expect(shellInvocation('darwin', true)).toMatchObject({ file: '/bin/zsh' });
    expect(shellInvocation('darwin', true).argsFor('ls')).toEqual(['-lc', 'ls']);
    expect(shellInvocation('linux', false).file).toBe('/bin/sh');
    const win = shellInvocation('win32', false);
    expect(win.file).toBe('powershell.exe');
    const args = win.argsFor('dir "한글 폴더"');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(args).toHaveLength(4);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    expect(script.startsWith('[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8;')).toBe(true);
    expect(script).toContain('\ndir "한글 폴더"\n');
    // 명령 바로 다음 줄에서 $? (성공 여부) 를 붙잡아 둔다 — 실패한 cmdlet(예: Get-Item nope)이
    // 그 뒤 판정문 때문에 종료 코드 0으로 덮이지 않도록.
    expect(script).toContain('\ndir "한글 폴더"\n$__ok = $?; $__code = $LASTEXITCODE\n');
    expect(script).toContain('if ($null -ne $__code -and $__code -ne 0) { exit $__code } elseif (-not $__ok) { exit 1 } else { exit 0 }');
    expect(script.indexOf('dir "한글 폴더"')).toBeLessThan(script.indexOf('$__ok = $?'));
  });
});

describe('shell_exec', () => {
  it('stdin 은 닫혀 있어 입력을 기다리는 명령이 멈추지 않는다', async () => {
    const { run } = await setup();
    const { json } = await run({ command: node("process.stdin.resume(); process.stdin.on('end', () => console.log('eof'))"), timeoutSec: 5 });
    expect(json.timedOut).toBe(false);
    expect(json.stdout.trim()).toBe('eof');
  });

  it('출력과 종료 코드', async () => {
    const { run } = await setup();
    const { json } = await run({ command: node("console.log('hi'); console.error('err'); process.exit(3)") });
    expect(json.exitCode).toBe(3);
    expect(json.stdout.trim()).toBe('hi');
    expect(json.stderr.trim()).toBe('err');
    expect(json.timedOut).toBe(false);
  });

  it('cwd 는 허용 폴더 안이어야 한다', async () => {
    const { run, allowed } = await setup();
    const ok = await run({ command: node('console.log(process.cwd())'), cwd: 'work' });
    expect(ok.json.stdout.trim()).toBe(path.join(allowed, 'work'));
    const bad = await run({ command: 'echo x', cwd: '/' });
    expect(bad.r.isError).toBe(true);
    expect(bad.json.error).toBe('path_not_allowed');
  });

  it('타임아웃이면 종료시키고 timedOut', async () => {
    const { run } = await setup();
    const started = Date.now();
    const { json } = await run({ command: node('setTimeout(()=>{}, 60000)'), timeoutSec: 1 });
    expect(json.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('caps huge output: 64KB 에서 잘린다', async () => {
    const { run } = await setup();
    const { json } = await run({ command: node("process.stdout.write('x'.repeat(500000))") });
    expect(json.stdout.length + json.stderr.length).toBeLessThanOrEqual(SHELL_OUTPUT_MAX);
    expect(json.truncated).toBe(true);
  });

  it('한글 출력은 청크 경계에서 깨지지 않는다', async () => {
    const { run } = await setup();
    const { json } = await run({ command: node("process.stdout.write('가'.repeat(30000))") });
    expect(json.stdout).not.toContain('�');
    expect(Buffer.byteLength(json.stdout, 'utf8')).toBeLessThanOrEqual(SHELL_OUTPUT_MAX);
    expect(json.truncated).toBe(true);
  });

  it('64KB 제한은 바이트 기준으로 합산된다(멀티바이트 포함)', async () => {
    const { run } = await setup();
    const { json } = await run({ command: node("process.stdout.write('가'.repeat(30000))") });
    const totalBytes = Buffer.byteLength(json.stdout, 'utf8') + Buffer.byteLength(json.stderr, 'utf8');
    expect(totalBytes).toBeLessThanOrEqual(SHELL_OUTPUT_MAX);
  });

  it.skipIf(process.platform === 'win32')('손자 프로세스가 파이프를 물고 있어도 멈추지 않는다', async () => {
    const { run } = await setup();
    const started = Date.now();
    const { json } = await run({
      command:
        "node -e \"require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'inherit',detached:true}).unref(); console.log('parent done')\"",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(json.stdout).toContain('parent done');
  });

  it('timeoutSec 범위 밖은 invalid_argument', async () => {
    const { run } = await setup();
    expect((await run({ command: 'echo x', timeoutSec: 301 })).json.error).toBe('invalid_argument');
  });

  it('메타: 확인 항상, 쓰기 도구', async () => {
    const { tool } = await setup();
    expect(tool.name).toBe('shell_exec');
    expect(tool.confirm).toBe('always');
    expect(tool.readOnly).toBe(false);
    expect(tool.summarize({ command: 'git status' })).toBe('git status');
  });
});
