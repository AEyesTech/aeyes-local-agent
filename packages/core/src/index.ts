export { AGENT_VERSION } from './version.js';
export { ToolError, type ToolErrorCode } from './errors.js';
export {
  ConfigStore, ConfigCorruptedError, defaultConfigDir, defaultAllowedDir, DEFAULT_PORT, PORT_RANGE_END,
  type AgentConfig, type AlwaysAllowRecord, type PairingRecord,
} from './config.js';
export { startAgent, type AgentOptions, type RunningAgent } from './server.js';
export { autoAllowConfirmer, denyAllConfirmer, type Confirmer, type ConfirmDecision, type ConfirmRequest } from './policy/confirmer.js';
export { CONFIRM_TIMEOUT_MS, INPUT_TOOLS, SESSION_GRANT_TTL_MS, sessionGrantKey } from './policy/gate.js';
export { TRUSTED_ORIGINS } from './security/origin.js';
export type { PairingManager } from './security/pairing.js';
export { buildDefaultTools } from './tools/index.js';
export type { ToolDef } from './tools/types.js';
export { unsafeAllowedDirReason } from './paths.js';
export { PID_FILE, isPidAlive, readRunningPid, writePidFile, removePidFile } from './pidFile.js';
export { MAX_QUEUED_CONFIRMATIONS, sanitizeForTerminal, truncateSummaryForDisplay } from './terminal.js';
