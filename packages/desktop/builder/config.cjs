/**
 * electron-builder 설정 생성기. 서명·공증 자격은 환경 변수로만 받는다(값을 저장소에 두지 않는다).
 * - macOS 인증서(CSC_LINK/CSC_NAME)가 없으면 ad-hoc 서명(identity '-'), hardened runtime·공증 없음.
 * - Windows 인증서(WIN_CSC_LINK/CSC_LINK)가 없으면 electron-builder 가 서명을 건너뛴다(미서명).
 * - macOS 자동 업데이트(Squirrel.Mac)는 zip 이 필요해 dmg 와 함께 만든다.
 */
function has(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
}

function buildConfig(env) {
  const macSigned = has(env, 'CSC_LINK') || has(env, 'CSC_NAME');
  const appleIdAuth = has(env, 'APPLE_ID') && has(env, 'APPLE_APP_SPECIFIC_PASSWORD') && has(env, 'APPLE_TEAM_ID');
  const appleApiAuth = has(env, 'APPLE_API_KEY') && has(env, 'APPLE_API_KEY_ID') && has(env, 'APPLE_API_ISSUER');
  return {
    appId: 'dev.aeyes.agent',
    productName: 'AeyeStudio Agent',
    artifactName: 'aeyes-agent-${version}-${os}-${arch}.${ext}',
    directories: { output: 'release', buildResources: 'build' },
    files: ['dist/**/*', 'static/**/*', 'package.json'],
    asarUnpack: ['**/node_modules/screenshot-desktop/**', '**/node_modules/@nut-tree-fork/**'],
    // 네이티브 모듈은 N-API 사전 빌드(macOS 는 유니버설 바이너리)라 다시 빌드하지 않는다.
    npmRebuild: false,
    publish: [{ provider: 'github', owner: 'AEyesTech', repo: 'aeyes-local-agent', releaseType: 'release' }],
    mac: {
      category: 'public.app-category.productivity',
      target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
      ...(macSigned ? {} : { identity: '-' }),
      hardenedRuntime: macSigned,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      notarize: macSigned && (appleIdAuth || appleApiAuth),
      // 두 아키텍처 빌드에 같은 유니버설 .node 가 들어가므로 병합 시 그대로 둔다.
      x64ArchFiles: '**/node_modules/**/*.node',
      extendInfo: { LSUIElement: true },
    },
    win: { target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: { oneClick: true, perMachine: false, runAfterFinish: true },
  };
}

function signingWarnings(env) {
  const warnings = [];
  if (!has(env, 'CSC_LINK') && !has(env, 'CSC_NAME')) {
    warnings.push('macOS 서명 인증서가 없어 ad-hoc 서명·미공증 빌드를 만듭니다. 설치 시 "확인되지 않은 개발자" 경고가 뜨고 자동 업데이트가 적용되지 않습니다.');
  }
  if (!has(env, 'WIN_CSC_LINK') && !has(env, 'CSC_LINK')) {
    warnings.push('Windows 코드 서명 인증서가 없어 미서명 설치 파일을 만듭니다. 설치 시 SmartScreen 경고가 뜹니다.');
  }
  return warnings;
}

module.exports = { buildConfig, signingWarnings };
