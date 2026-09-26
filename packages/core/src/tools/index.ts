import { createClipboardTools } from './clipboard.js';
import { createExcelTools } from './excel.js';
import { createFsTools } from './fs.js';
import { createOpenTools } from './open.js';
import { createShellTools } from './shell.js';
import type { ToolDef } from './types.js';

/** 1단계 도구 전체. screenshot·마우스·키보드·db_query 는 3단계. */
export function buildDefaultTools(): ToolDef[] {
  return [...createFsTools(), ...createExcelTools(), ...createClipboardTools(), ...createOpenTools(), ...createShellTools()];
}
