import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Env = Record<string, string | undefined>;
interface MacConfig { identity?: string | null; hardenedRuntime: boolean; notarize: boolean; target: unknown; x64ArchFiles: string; extendInfo: Record<string, unknown>; entitlements: string }
interface BuilderConfig {
  appId: string; productName: string; artifactName: string; asarUnpack: string[]; npmRebuild: boolean;
  publish: Array<{ provider: string; owner: string; repo: string }>; mac: MacConfig; win: { target: unknown }; files: string[];
}
const require = createRequire(import.meta.url);
const { buildConfig, signingWarnings } = require('../builder/config.cjs') as {
  buildConfig(env: Env): BuilderConfig;
  signingWarnings(env: Env): string[];
};

describe('electron-builder 설정', () => {
  it('인증서가 없으면 macOS ad-hoc·공증 없음, 경고 두 개', () => {
    const c = buildConfig({});
    expect(c.mac.identity).toBe('-');
    expect(c.mac.hardenedRuntime).toBe(false);
    expect(c.mac.notarize).toBe(false);
    expect(signingWarnings({})).toHaveLength(2);
    expect(buildConfig({ CSC_LINK: '  ' }).mac.identity).toBe('-');
  });

  it('macOS 인증서가 있으면 서명(hardened runtime), Apple 자격이 모두 있을 때만 공증', () => {
    const signed = buildConfig({ CSC_LINK: 'base64cert' });
    expect('identity' in signed.mac).toBe(false);
    expect(signed.mac.hardenedRuntime).toBe(true);
    expect(signed.mac.notarize).toBe(false);
    expect(buildConfig({ CSC_LINK: 'x', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }).mac.notarize).toBe(true);
    expect(buildConfig({ CSC_LINK: 'x', APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }).mac.notarize).toBe(true);
    expect(buildConfig({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }).mac.notarize).toBe(false);
    expect(signingWarnings({ CSC_LINK: 'x', WIN_CSC_LINK: 'y' })).toEqual([]);
  });

  it('대상·게시·산출물 이름', () => {
    const c = buildConfig({});
    expect(c.appId).toBe('dev.aeyes.agent');
    expect(c.productName).toBe('AeyeStudio Agent');
    expect(c.artifactName).not.toContain(' ');
    expect(c.mac.target).toEqual([{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }]);
    expect(c.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(c.publish).toEqual([{ provider: 'github', owner: 'AEyesTech', repo: 'aeyes-local-agent', releaseType: 'release' }]);
    expect(c.asarUnpack).toEqual(expect.arrayContaining(['**/node_modules/screenshot-desktop/**', '**/node_modules/@nut-tree-fork/**']));
    expect(c.npmRebuild).toBe(false);
    expect(c.mac.extendInfo.LSUIElement).toBe(true);
    expect(c.mac.x64ArchFiles).toBe('**/node_modules/**/*.node');
    expect(c.files).toEqual(['dist/**/*', 'static/**/*', 'package.json']);
  });
});
