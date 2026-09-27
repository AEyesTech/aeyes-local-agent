import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('공개 API', () => {
  it('데스크톱 앱이 쓰는 이름을 내보낸다', () => {
    for (const name of [
      'startAgent', 'ConfigStore', 'defaultConfigDir', 'AGENT_VERSION', 'readRunningPid', 'writePidFile', 'removePidFile',
      'isPidAlive', 'PID_FILE', 'unsafeAllowedDirReason', 'sanitizeForTerminal', 'truncateSummaryForDisplay',
      'MAX_QUEUED_CONFIRMATIONS', 'CONFIRM_TIMEOUT_MS', 'SESSION_GRANT_TTL_MS', 'INPUT_TOOLS', 'sessionGrantKey',
      'loadNativeDrivers', 'NO_NATIVE', 'AgentAlreadyRunningError', 'KEY_NAMES', 'DATABASE_NAME_PATTERN', 'classifySql', 'createDefaultDbDrivers',
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });
});
