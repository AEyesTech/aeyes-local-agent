/**
 * `aeyes-local-agent db add|list|remove` 동작. 연결 문자열은 표준 입력으로만 받고 어디에도 출력하지 않는다.
 */
import { DATABASE_NAME_PATTERN, type ConfigStore, type DatabaseKind, type DatabaseRecord } from './config.js';
import { connectionStringError } from './db/connection.js';
import { readSecretLine } from './secretInput.js';

export interface CliIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
}

export function formatDatabaseList(databases: DatabaseRecord[]): string {
  if (databases.length === 0) return 'DB 연결 없음 — 추가: aeyes-local-agent db add <이름> --kind postgres|mysql\n';
  const lines = databases.map((d) => `  - ${d.name} (${d.kind}, ${d.readOnly ? '읽기 전용' : '읽기·쓰기'})`);
  return `DB 연결 ${databases.length}개:\n${lines.join('\n')}\n`;
}

export async function addDatabase(
  store: ConfigStore,
  input: { name: string; kind: DatabaseKind; readWrite: boolean },
  io: CliIo
): Promise<number> {
  if (!DATABASE_NAME_PATTERN.test(input.name)) {
    io.error.write('DB 이름은 영문·숫자·_·- 로 1~40자이고 영문·숫자로 시작해야 합니다.\n');
    return 1;
  }
  if (store.get().databases.some((d) => d.name === input.name)) {
    io.error.write(`이미 있는 DB 이름입니다: ${input.name}\n`);
    return 1;
  }
  let connectionString: string;
  try {
    connectionString = await readSecretLine(io.input, io.output, '연결 문자열(입력 내용은 화면에 보이지 않습니다): ');
  } catch (error) {
    io.error.write(`${(error as Error).message}\n`);
    return 1;
  }
  const problem = connectionStringError(input.kind, connectionString);
  if (problem) {
    io.error.write(`${problem}\n`);
    return 1;
  }
  await store.update((c) => {
    c.databases.push({ name: input.name, kind: input.kind, connectionString, readOnly: !input.readWrite });
  });
  io.output.write(
    `DB '${input.name}'(${input.kind}, ${input.readWrite ? '읽기·쓰기 — 쓰기 쿼리는 PC 에서 확인' : '읽기 전용'})를 추가했습니다. ` +
    '연결 문자열은 설정 파일(권한 0600)에만 저장됩니다. 에이전트를 다시 시작하면 db_query 도구가 나타납니다.\n'
  );
  return 0;
}

export async function removeDatabase(store: ConfigStore, name: string, io: CliIo): Promise<number> {
  if (!store.get().databases.some((d) => d.name === name)) {
    io.error.write(`없는 DB 이름입니다: ${name}\n`);
    return 1;
  }
  await store.update((c) => { c.databases = c.databases.filter((d) => d.name !== name); });
  io.output.write(`DB '${name}' 연결을 지웠습니다.\n`);
  return 0;
}
