import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config.js';
import { denyAllConfirmer } from '../src/policy/confirmer.js';
import { startAgent } from '../src/server.js';

describe('startAgent onPaired', () => {
  it('페어링 성공 시 onPaired 를 부르고, 콜백 예외는 페어링을 막지 않는다', async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-hook-')));
    const store = await ConfigStore.open(path.join(home, '.a'), home);
    const seen: string[] = [];
    const agent = await startAgent({
      store,
      confirmer: denyAllConfirmer,
      onPaired: (record) => { seen.push(`${record.accountLabel}|${record.browserLabel}`); throw new Error('ui gone'); },
    });
    try {
      const { code } = agent.pairing.createCode();
      const res = await fetch(`http://127.0.0.1:${agent.port}/pair`, {
        method: 'POST',
        headers: { origin: 'https://studio.aeyes.dev', 'content-type': 'application/json' },
        body: JSON.stringify({ code, accountLabel: 'ky***@gmail.com', browserLabel: 'Chrome' }),
      });
      expect(res.status).toBe(200);
      expect(seen).toEqual(['ky***@gmail.com|Chrome']);
    } finally {
      await agent.close();
    }
  });
});
