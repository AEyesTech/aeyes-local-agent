import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_VERSION } from '../src/version.js';
import { ToolError } from '../src/errors.js';

describe('version', () => {
  it('package.json 버전과 같다', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(AGENT_VERSION).toBe(pkg.version);
  });

  it('npm 배포 설정: 공개 접근, 배포 전 빌드, MIT 라이선스, 패키지 이름', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.scripts.prepublishOnly).toBe('pnpm build');
    expect(pkg.license).toBe('MIT');
    expect(pkg.name).toBe('aeyes-local-agent');
    expect(pkg.repository).toBeUndefined();
  });
});

describe('ToolError', () => {
  it('코드를 보존한다', () => {
    const err = new ToolError('path_not_allowed', 'nope');
    expect(err.code).toBe('path_not_allowed');
    expect(err.message).toBe('nope');
    expect(err).toBeInstanceOf(Error);
  });
});
