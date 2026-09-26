/**
 * 에이전트 설정(~/.aeyes-agent/config.json). 페어링·항상 허용·허용 폴더를 담는다.
 * 깨진 설정은 덮어쓰지 않는다 — 페어링 정보를 조용히 잃지 않기 위해 시작을 거부한다.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface PairingRecord {
  id: string;
  tokenHash: string;
  accountLabel: string;
  browserLabel: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AlwaysAllowRecord {
  key: string;
  createdAt: string;
}

export interface AgentConfig {
  port: number;
  allowedDirs: string[];
  pairings: PairingRecord[];
  alwaysAllow: AlwaysAllowRecord[];
}

export const DEFAULT_PORT = 47821;
export const PORT_RANGE_END = 47830;
const CONFIG_FILE = 'config.json';

export class ConfigCorruptedError extends Error {
  constructor(file: string) {
    super(`설정 파일을 읽을 수 없습니다(JSON 오류): ${file} — 파일을 고치거나 지운 뒤 다시 실행하세요.`);
    this.name = 'ConfigCorruptedError';
  }
}

export function defaultConfigDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'), 'aeyes-agent');
  }
  return path.posix.join(home, '.aeyes-agent');
}

export function defaultAllowedDir(home: string = homedir()): string {
  return path.join(home, 'Documents', 'AeyeStudio');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalize(raw: unknown, home: string): AgentConfig {
  const r = isRecord(raw) ? raw : {};
  const port = Number.isInteger(r.port) && (r.port as number) >= DEFAULT_PORT && (r.port as number) <= PORT_RANGE_END
    ? (r.port as number)
    : DEFAULT_PORT;
  const dirs = Array.isArray(r.allowedDirs) ? r.allowedDirs.filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
  const pairings = Array.isArray(r.pairings)
    ? r.pairings.filter(isRecord).flatMap((p) => {
        const id = str(p.id);
        const tokenHash = str(p.tokenHash);
        if (!id || !tokenHash) return [];
        return [{
          id,
          tokenHash,
          accountLabel: str(p.accountLabel) ?? '',
          browserLabel: str(p.browserLabel) ?? '',
          createdAt: str(p.createdAt) ?? new Date(0).toISOString(),
          lastUsedAt: str(p.lastUsedAt),
        }];
      })
    : [];
  const alwaysAllow = Array.isArray(r.alwaysAllow)
    ? r.alwaysAllow.filter(isRecord).flatMap((a) => {
        const key = str(a.key);
        return key ? [{ key, createdAt: str(a.createdAt) ?? new Date(0).toISOString() }] : [];
      })
    : [];
  return { port, allowedDirs: dirs.length > 0 ? dirs : [defaultAllowedDir(home)], pairings, alwaysAllow };
}

export class ConfigStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly dir: string, private current: AgentConfig) {}

  static async open(dir: string, home: string = homedir()): Promise<ConfigStore> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, CONFIG_FILE);
    let raw: unknown = {};
    try {
      const text = await readFile(file, 'utf8');
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ConfigCorruptedError(file);
      }
    } catch (error) {
      if (error instanceof ConfigCorruptedError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const store = new ConfigStore(dir, normalize(raw, home));
    await Promise.all(store.current.allowedDirs.map((d) => mkdir(d, { recursive: true })));
    await store.write();
    return store;
  }

  get(): AgentConfig {
    return structuredClone(this.current);
  }

  /** 직렬화된 수정: 동시에 불려도 앞선 수정을 잃지 않는다. */
  update(fn: (config: AgentConfig) => void): Promise<AgentConfig> {
    const run = this.queue.then(async () => {
      const next = structuredClone(this.current);
      fn(next);
      this.current = next;
      await this.write();
      return this.get();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(): Promise<void> {
    const file = path.join(this.dir, CONFIG_FILE);
    await writeFile(file, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => undefined);
  }
}
