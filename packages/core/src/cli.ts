#!/usr/bin/env node
/**
 * npx aeyes-local-agent 진입점.
 * 시작하면 포트와 페어링 코드를 보여 주고, p=새 코드, u=전체 해제, g=항상 허용 목록, r=항상 허용 초기화, q=종료 명령을 받는다.
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConfigStore, defaultConfigDir, DEFAULT_PORT, PORT_RANGE_END, type DatabaseKind } from './config.js';
import { addDatabase, formatDatabaseList, removeDatabase } from './dbCli.js';
import { autoAllowConfirmer } from './policy/confirmer.js';
import { unsafeAllowedDirReason } from './paths.js';
import { readRunningPid, removePidFile, writePidFile } from './pidFile.js';
import { startAgent as defaultStartAgent } from './server.js';
import { sanitizeForTerminal, TerminalIO } from './terminal.js';
import { AGENT_VERSION } from './version.js';

export interface CliArgs {
  command: 'start' | 'unpair-all' | 'db-add' | 'db-list' | 'db-remove' | 'help' | 'version';
  port?: number;
  allowDirs: string[];
  dev: boolean;
  autoConfirm: boolean;
  configDir?: string;
  dbName?: string;
  dbKind?: DatabaseKind;
  dbReadWrite?: boolean;
}

const COMMANDS = 'p = 새 페어링 코드, u = 모든 연결 해제, g = 항상 허용 목록, r = 항상 허용 초기화, q = 종료';

const HELP = `사용법: aeyes-local-agent [옵션]
       aeyes-local-agent unpair --all
       aeyes-local-agent db add <이름> --kind postgres|mysql [--read-write]
       aeyes-local-agent db list
       aeyes-local-agent db remove <이름>

옵션:
  --port <47821-47830>   선호 포트
  --allow-dir <경로>      허용 폴더 추가(여러 번 가능)
  --config-dir <경로>     설정 폴더(기본 ~/.aeyes-agent)
  --dev                  개발 모드(localhost origin 허용)
  --auto-confirm         로컬 확인 자동 허용(--dev 에서만)
  --version, --help

실행 중 명령: ${COMMANDS}

DB 연결 문자열은 명령 인자로 받지 않고 실행 후 입력받습니다(화면에 보이지 않음). 새 DB 는 기본 읽기 전용입니다.`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: 'start', allowDirs: [], dev: false, autoConfirm: false };
  const rest = [...argv];
  if (rest[0] === 'unpair') {
    rest.shift();
    const next = rest.shift();
    if (next !== '--all') throw new Error('unpair 는 --all 과 함께 써야 합니다');
    args.command = 'unpair-all';
  }
  if (rest[0] === 'db') {
    rest.shift();
    const sub = rest.shift();
    if (sub === 'list') {
      args.command = 'db-list';
    } else if (sub === 'add' || sub === 'remove') {
      const name = rest.shift();
      if (!name || name.startsWith('-')) throw new Error(`db ${sub} 뒤에 DB 이름이 필요합니다`);
      args.command = sub === 'add' ? 'db-add' : 'db-remove';
      args.dbName = name;
    } else {
      throw new Error('db 명령은 add <이름> | list | remove <이름> 입니다');
    }
  }
  while (rest.length > 0) {
    const flag = rest.shift()!;
    const value = () => {
      const v = rest.shift();
      if (v === undefined) throw new Error(`${flag} 값이 필요합니다`);
      return v;
    };
    switch (flag) {
      case '--port': {
        const port = Number(value());
        if (!Number.isInteger(port) || port < DEFAULT_PORT || port > PORT_RANGE_END) {
          throw new Error(`--port 는 ${DEFAULT_PORT}~${PORT_RANGE_END} 사이여야 합니다`);
        }
        args.port = port;
        break;
      }
      case '--allow-dir': args.allowDirs.push(path.resolve(value())); break;
      case '--config-dir': args.configDir = path.resolve(value()); break;
      case '--kind': {
        const kind = value();
        if (kind !== 'postgres' && kind !== 'mysql') throw new Error('--kind 는 postgres 또는 mysql 입니다');
        args.dbKind = kind;
        break;
      }
      case '--read-write': args.dbReadWrite = true; break;
      case '--dev': args.dev = true; break;
      case '--auto-confirm': args.autoConfirm = true; break;
      case '--help': case '-h': args.command = 'help'; break;
      case '--version': case '-v': args.command = 'version'; break;
      default: throw new Error(`알 수 없는 인자: ${flag}`);
    }
  }
  if (args.command === 'db-add' && !args.dbKind) throw new Error('db add 는 --kind postgres|mysql 이 필요합니다');
  return args;
}

type Io = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; error: NodeJS.WritableStream };

/** 테스트에서 바꿔 끼울 수 있는 의존성. */
export interface MainDeps {
  startAgent?: typeof defaultStartAgent;
}

const realOrResolved = (p: string) => realpath(p).catch(() => path.resolve(p));

function startErrorMessage(error: unknown): string {
  if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    return `포트 ${DEFAULT_PORT}~${PORT_RANGE_END} 이 모두 사용 중이라 시작할 수 없습니다. 다른 프로그램을 종료하거나 이미 실행 중인 에이전트를 확인하세요.`;
  }
  return `에이전트를 시작할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`;
}

export async function main(
  argv: string[],
  io: Io = { input: process.stdin, output: process.stdout, error: process.stderr },
  deps: MainDeps = {}
): Promise<number> {
  const startAgent = deps.startAgent ?? defaultStartAgent;
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.error.write(`${(e as Error).message}\n\n${HELP}\n`);
    return 1;
  }
  if (args.command === 'help') { io.output.write(`${HELP}\n`); return 0; }
  if (args.command === 'version') { io.output.write(`${AGENT_VERSION}\n`); return 0; }
  if (args.autoConfirm && !args.dev) {
    io.error.write('--auto-confirm 은 --dev 와 함께일 때만 쓸 수 있습니다.\n');
    return 1;
  }

  let store: ConfigStore;
  try {
    store = await ConfigStore.open(args.configDir ?? defaultConfigDir());
  } catch (e) {
    io.error.write(`${(e as Error).message}\n`);
    return 1;
  }

  if (args.command === 'db-list') {
    io.output.write(formatDatabaseList(store.get().databases));
    return 0;
  }
  if (args.command === 'db-add' || args.command === 'db-remove') {
    const runningPid = await readRunningPid(store.dir);
    if (runningPid !== null) {
      io.error.write(`에이전트가 실행 중입니다(pid ${runningPid}). 터미널 에이전트나 데스크톱 앱을 종료한 뒤 다시 실행하세요.\n`);
      return 1;
    }
    return args.command === 'db-add'
      ? addDatabase(store, { name: args.dbName ?? '', kind: args.dbKind ?? 'postgres', readWrite: args.dbReadWrite === true }, io)
      : removeDatabase(store, args.dbName ?? '', io);
  }

  if (args.command === 'unpair-all') {
    const runningPid = await readRunningPid(store.dir);
    if (runningPid !== null) {
      io.error.write('에이전트가 실행 중입니다. 실행 중인 터미널에서 u 를 입력해 연결을 해제하세요.\n');
      return 1;
    }
    let count = 0;
    await store.update((c) => { count = c.pairings.length; c.pairings = []; });
    io.output.write(`연결 ${count}개를 해제했습니다.\n`);
    return 0;
  }

  // 같은 설정 폴더로 두 번째 에이전트를 띄우지 않는다(설정·pid 파일 경합). 자기 pid 는 오래된 파일로 본다.
  const livePid = await readRunningPid(store.dir);
  if (livePid !== null && livePid !== process.pid) {
    io.error.write(`이미 에이전트가 실행 중입니다(pid ${livePid}). 실행 중인 터미널을 사용하거나 먼저 종료하세요.\n`);
    return 1;
  }

  // 너무 넓은 허용 폴더는 받지 않는다(루트·홈·홈 상위·설정 폴더를 포함하는 폴더).
  if (args.allowDirs.length > 0) {
    const home = await realOrResolved(homedir());
    const configDir = await realOrResolved(store.dir);
    for (const dir of args.allowDirs) {
      const reason = unsafeAllowedDirReason(await realOrResolved(dir), { home, configDir });
      if (reason) {
        io.error.write(`--allow-dir ${dir} 는 쓸 수 없습니다: ${reason}\n`);
        return 1;
      }
    }
  }

  if (args.port !== undefined || args.allowDirs.length > 0) {
    await store.update((c) => {
      if (args.port !== undefined) c.port = args.port;
      for (const dir of args.allowDirs) if (!c.allowedDirs.includes(dir)) c.allowedDirs.push(dir);
    });
  }

  const terminal = new TerminalIO(io.input, io.output);
  let agent: Awaited<ReturnType<typeof defaultStartAgent>>;
  try {
    agent = await startAgent({ store, confirmer: args.autoConfirm ? autoAllowConfirmer : terminal, dev: args.dev });
  } catch (error) {
    terminal.close();
    io.error.write(`${startErrorMessage(error)}\n`);
    return 1;
  }
  await writePidFile(store.dir);
  const showCode = () => {
    const { code, expiresAt } = agent.pairing.createCode();
    io.output.write(`\n페어링 코드: ${code}  (${new Date(expiresAt).toLocaleTimeString()}까지, AeyeStudio 설정 > 내 PC 연결에 입력)\n`);
  };
  io.output.write(
    `AeyeStudio 로컬 에이전트 ${AGENT_VERSION} — http://127.0.0.1:${agent.port}\n` +
    `허용 폴더: ${store.get().allowedDirs.join(', ')}\n` +
    (args.dev ? '개발 모드(localhost origin 허용)\n' : '') +
    (args.autoConfirm ? '⚠ 로컬 확인 자동 허용 중(개발 전용)\n' : '') +
    `명령: ${COMMANDS}\n`
  );
  showCode();
  void agent.toolNames().then((names) => {
    if (!names.includes('screenshot') || !names.includes('mouse_move')) {
      io.output.write('화면 캡처·마우스·키보드 도구는 이 PC 에서 쓸 수 없습니다(선택 구성요소를 불러오지 못함). 나머지 도구는 정상입니다.\n');
    }
    if (names.includes('db_query')) {
      io.output.write(`DB 조회(db_query): ${store.get().databases.map((d) => d.name).join(', ')}\n`);
    }
  }, () => undefined);

  return new Promise<number>((resolve) => {
    const shutdown = async () => {
      terminal.close();
      await agent.close();
      await removePidFile(store.dir).catch(() => undefined);
      resolve(0);
    };
    terminal.onCommand((line) => {
      const cmd = line.toLowerCase();
      if (cmd === 'p') showCode();
      else if (cmd === 'u') {
        void agent.pairing.revokeAll().then(
          (n) => io.output.write(`연결 ${n}개를 해제했습니다.\n`),
          (error: unknown) => io.error.write(`연결 해제에 실패했습니다: ${(error as Error)?.message ?? String(error)}\n`)
        );
      } else if (cmd === 'g') {
        const grants = store.get().alwaysAllow;
        io.output.write(grants.length === 0
          ? '항상 허용 없음\n'
          : `항상 허용 ${grants.length}개:\n${grants.map((g) => `  - ${sanitizeForTerminal(g.key, 200)} (${sanitizeForTerminal(g.createdAt, 40)})`).join('\n')}\n`);
      } else if (cmd === 'r') {
        let count = 0;
        void store.update((c) => { count = c.alwaysAllow.length; c.alwaysAllow = []; }).then(
          () => {
            const sessions = agent.clearSessionGrants();
            io.output.write(`항상 허용 ${count}개를 지웠습니다. 이 세션 동안 허용 ${sessions}개도 취소했습니다. 이제 모두 다시 묻습니다.\n`);
          },
          (error: unknown) => io.error.write(`항상 허용 초기화에 실패했습니다: ${(error as Error)?.message ?? String(error)}\n`)
        );
      } else if (cmd === 'q') void shutdown();
      else io.output.write(`명령: ${COMMANDS}\n`);
    });
    if (io.input === process.stdin) {
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
    }
  });
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${startErrorMessage(error)}\n`);
      process.exit(1);
    }
  );
}
