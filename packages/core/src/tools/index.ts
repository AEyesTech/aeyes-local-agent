import type { DatabaseRecord } from '../config.js';
import { createDefaultDbDrivers, type DbDrivers } from '../db/drivers.js';
import type { NativeDrivers } from '../native.js';
import { createClipboardTools } from './clipboard.js';
import { createDbTools } from './db.js';
import { createExcelTools } from './excel.js';
import { createFsTools } from './fs.js';
import { createInputTools } from './input.js';
import { createOpenTools } from './open.js';
import { createScreenTools } from './screen.js';
import { createShellTools } from './shell.js';
import type { ToolDef } from './types.js';

export interface DefaultToolOptions {
  /** 불러온 네이티브 드라이버. 없는 쪽(null)의 도구는 등록하지 않는다. */
  native?: NativeDrivers;
  /** 설정 databases 조회. 비어 있으면 db_query 를 등록하지 않는다. */
  databases?: () => DatabaseRecord[];
  dbDrivers?: DbDrivers;
}

/** 1단계 도구 + (있으면) 화면·입력·DB 도구. */
export function buildDefaultTools(opts: DefaultToolOptions = {}): ToolDef[] {
  return [
    ...createFsTools(),
    ...createExcelTools(),
    ...createClipboardTools(),
    ...createOpenTools(),
    ...createShellTools(),
    ...(opts.native?.screen ? createScreenTools(opts.native.screen) : []),
    ...(opts.native?.input ? createInputTools(opts.native.input) : []),
    ...(opts.databases ? createDbTools({ databases: opts.databases, drivers: opts.dbDrivers ?? createDefaultDbDrivers() }) : []),
  ];
}
