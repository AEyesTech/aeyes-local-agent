/**
 * 감사 로그(한 줄 JSON). 인자는 경로·명령·이름·URL·시트명만 120자로 요약하고 내용은 남기지 않는다.
 */
import { appendFile, rename, stat } from 'node:fs/promises';

export interface AuditEntry {
  tool: string;
  origin: string;
  pairingId: string;
  result: 'ok' | 'denied' | 'error';
  ms: number;
  args: string;
}

const SUMMARY_FIELDS = ['path', 'from', 'to', 'cwd', 'command', 'name', 'target', 'sheet', 'query', 'database', 'sql'] as const;
const FIELD_MAX = 120;
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;

export function summarizeArgs(args: Record<string, unknown>): string {
  const out: Record<string, string> = {};
  for (const field of SUMMARY_FIELDS) {
    const value = args[field];
    if (typeof value === 'string') out[field] = value.slice(0, FIELD_MAX);
  }
  return JSON.stringify(out);
}

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly maxBytes: number = AUDIT_MAX_BYTES) {}

  write(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    const run = this.queue.then(async () => {
      const size = await stat(this.file).then((s) => s.size).catch(() => 0);
      if (size + Buffer.byteLength(line) > this.maxBytes && size > 0) {
        await rename(this.file, `${this.file}.1`);
      }
      await appendFile(this.file, line, { mode: 0o600 });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
